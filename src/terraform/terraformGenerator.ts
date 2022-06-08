import * as clc from "cli-color";
import * as fs from "fs";

import { promisify } from "util";
import { Question, promptOnce } from "../prompt";

export interface FirebaseTerraformExportMetadata {
  projectId: string;
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
  }
}

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

export async function generateFirebaseTerraformExportConfig(
  exportConfig: FirebaseTerraformExportMetadata,
  outputPath: string
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
      },
  }, null, 2);

  await promisify(fs.writeFile)(outputPath, jsonContent);
}
