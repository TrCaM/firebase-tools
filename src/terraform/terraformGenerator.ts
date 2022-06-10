import * as clc from "cli-color";
import * as fs from "fs";

import { Client } from "../apiv2";
import { promisify } from "util";
import * as api from "../api";
import { Question, promptOnce } from "../prompt";
import { logBullet, logWarning } from "../utils";

export interface FirebaseTerraformExportMetadata {
  projectId: string;
  originProjectId: string;
  projectDisplayName: string;
  region: string;
  locationId: string;
  zone: string;
  apis?: string[];
}

const TERRAFORM_BLOCK = {
  terraform: {
    required_version: ">= 0.12.0",
    required_providers: {
      google: {
        source: "hashicorp/google",
        // Don't use 5.0.0 unless you are using a custom build.
        // version: "5.0.0"
      },
    },
  },
};

const GOOGLE_PROVIDER_BLOCK = {
  google: {
    project: "${local.project}",
    region: "${local.region}",
    zone: "${local.zone}",
  },
};

const GOOGLE_BETA_PROVIDER_BLOCK = {
  "google-beta": {
    project: "${local.project}",
    region: "${local.region}",
    zone: "${local.zone}",
    user_project_override: true,
  },
};

const GOOGLE_PROJECT_RESOURCE_BLOCK = {
  google_project: {
    default: {
      provider: "google",
      folder_id: "${local.folder_id}",
      name: "${local.project_display_name}",
      project_id: "${local.project}",
    },
  },
};

const GOOGLE_PROJECT_SERVICE_RESOURCE_BLOCK = {
  google_project_service: {
    services: {
      provider: "google",
      project: "${google_project.default.project_id}",
      disable_on_destroy: false,
      for_each: "${toset(local.apis)}",
      service: "${each.key}",
    },
  },
};

const GOOGLE_APP_ENGINE_APPLICATION_BLOCK = {
  google_app_engine_application: {
    appengine: {
      project: "${google_project.default.project_id}",
      location_id: "${local.location_id}",
      database_type: "CLOUD_FIRESTORE",
    },
  },
};

const GOOGLE_FIREBASE_PROJECT_BLOCK = {
  google_firebase_project: {
    default: {
      provider: "google-beta",
      project: "${google_project.default.project_id}",
    },
  },
}

const GOOGLE_FIRESTORE_RULES_BLOCK = {
  google_firebaserules_ruleset: {
    firestore: {
      provider: "google-beta",
      project: "${google_project.default.project_id}",
      source: {
        files: {
          name: "firestore.rules",
          content: "${file(\"firestore.rules\")}"
        }
      }
    }
  },
  google_firebaserules_release: {
    primary: {
      name: "cloud.firestore",
      provider: "google-beta",
      ruleset_name: "projects/${google_project.default.project_id}/rulesets/${google_firebaserules_ruleset.firestore.name}",
      project: "${google_project.default.project_id}",
    },
  },
};

export const PROJECTS_CLONE_QUESTIONS: Question[] = [
  {
    type: "input",
    name: "projectId",
    default: "",
    message:
      "Please specify a unique project id " +
      `(${clc.yellow("warning")}: cannot be modified afterward) [6-30 characters]:\n`,
  },
  {
    type: "input",
    name: "displayName",
    default: "",
    message: "What would you like to call your project? (defaults to your project ID)",
  },
];

function generateLocalsBlock(exportConfig: FirebaseTerraformExportMetadata): any {
  const apiSet = new Set<string>(exportConfig.apis);
  return {
    locals: {
      project: exportConfig.projectId,
      project_display_name: exportConfig.projectDisplayName,
      folder_id: "1095975223327", // google-ism  if we omit this, it will try to move to the root folder which fails.
      location_id: exportConfig.locationId,
      region: exportConfig.region,
      zone: exportConfig.zone,
      apis: [...apiSet.values()],
    },
  };
}

interface IdpConfig {
  name: string;
  clientId: string;
  clientSecret: string;
};

const firestoreApiClient = new Client({
  urlPrefix: api.firestoreOrigin,
  auth: true,
  apiVersion: "v1beta1",
});

const authIdpClient = new Client({
  urlPrefix: api.identityOrigin,
  auth: true,
  apiVersion: "admin/v2",
});

async function generateIdPConfigBlock(exportConfig: FirebaseTerraformExportMetadata): Promise<any> {
  let authConfig;
  try {
    authConfig = await authIdpClient.request<any, IdpConfig>({
      method: "GET",
      path: `/projects/${exportConfig.projectId}/defaultSupportedIdpConfigs/google.com`
    });
  } catch (err: any) {
    authConfig = null
  }
  let idpBlock: any = {
  };

  if (true) {
    idpBlock = {
      gsi: {
        provider: "google-beta",
        enabled: true,
        idp_id: "google.com",
        client_id: authConfig?.body.clientId || "TODO",
        client_secret: authConfig?.body.clientSecret || "TODO",
      },
      ...idpBlock,
    };
  }

  return {
    google_identity_platform_default_supported_idp_config: {
      ...idpBlock,
    },
  };
}

function addslashes(str: string) {
    return (str + '').replace(/[\\"']/g, '\\$&').replace(/\u0000/g, '\\0');
}

async function generateFirestoreDocumentBlock(exportConfig: FirebaseTerraformExportMetadata): Promise<any> {
  const databasePath = `projects/${exportConfig.originProjectId}/databases/(default)`
  const collections = (await firestoreApiClient.request<any, any>({
    method: "POST",
    path: `${databasePath}/documents:listCollectionIds`
  })).body.collectionIds;

  let documentsResourceBlocks = {};
  let curDocumentResourceCount = 1;

  for (const collectionId of collections) {
    const documents = (await firestoreApiClient.request<any, any>({
      method: "GET",
      path: `/${databasePath}/documents/${collectionId}`
    })).body.documents;
    for (const document of documents) {
      const documentId = document.name.slice(document.name.lastIndexOf("/") + 1);

      documentsResourceBlocks = {
        ...documentsResourceBlocks,
        [`document-${curDocumentResourceCount++}`]: {
          provider: "google-beta",
          project: "${google_project.default.project_id}",
          collection: collectionId,
          document_id: documentId,
          fields: JSON.stringify(document.fields),
        },
      };
    }
  }

  return { google_firestore_document: documentsResourceBlocks };
}


export async function generateFirebaseTerraformExportConfig(
  exportConfig: FirebaseTerraformExportMetadata,
  outputFile: string
): Promise<void> {
  const jsonContent = JSON.stringify({
      ...TERRAFORM_BLOCK,
      ...generateLocalsBlock(exportConfig),
      provider: {
        ...GOOGLE_PROVIDER_BLOCK,
        ...GOOGLE_BETA_PROVIDER_BLOCK,
      },
      resource: {
        ...GOOGLE_PROJECT_RESOURCE_BLOCK,
        ...GOOGLE_PROJECT_SERVICE_RESOURCE_BLOCK,
        ...GOOGLE_APP_ENGINE_APPLICATION_BLOCK,
        ...GOOGLE_FIRESTORE_RULES_BLOCK,
        ...GOOGLE_FIREBASE_PROJECT_BLOCK,
        ...await generateFirestoreDocumentBlock(exportConfig),
        ...await generateIdPConfigBlock(exportConfig),
      },
  }, null, 2);

  await promisify(fs.writeFile)(`terraform/${outputFile}`, jsonContent);
}
