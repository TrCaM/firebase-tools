import * as fs from "fs";

import { Command } from "../command";
import { getFirebaseProject } from "../management/projects";
import { promisify } from "util";
import { FirebaseError } from "../error";
import { needProjectId } from "../projectUtils"
import { getLatestRulesetName, getRulesetContent, RulesetFile } from "../gcp/rules"
import {
  FirebaseTerraformExportMetadata,
  generateFirebaseTerraformExportConfig,
  PROJECTS_CLONE_QUESTIONS,
} from "../terraform/terraformGenerator";
import { requireAuth } from "../requireAuth";
import { logBullet, logWarning } from "../utils";
import { assert } from "console";

export const command = new Command("projects:clone [projectId]")
  .description(
    "export a terraform config file which can be used to clone the current firebase project."
  )
  .option("-n, --display-name <displayName>", "(optional) display name for the project")
  .option(
    "-o, --organization <organizationId>",
    "(optional) ID of the parent Google Cloud Platform organization under which to create this project"
  )
  .option(
    "-f, --folder <folderId>",
    "(optional) ID of the parent Google Cloud Platform folder in which to create this project"
  )
  .before(requireAuth)
  .action(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (projectId: string | undefined, options: any) => {
      if (options.organization && options.folder) {
        throw new FirebaseError(
          "Invalid argument, please provide only one type of project parent (organization or folder)"
        );
      }

      if (!projectId) {
        throw new FirebaseError("Project ID cannot be empty");
      }

      if (!fs.existsSync("./terraform")) {
        await promisify(fs.mkdir)("terraform");
      }

      const originProjectId = needProjectId(options);
      const originProjectMetadata = await getFirebaseProject(originProjectId);
      const rulesetName = await getLatestRulesetName(originProjectId, "cloud.firestore") || "";
      logBullet(rulesetName || "No ruleset found");
      if (rulesetName) {
        const rulesetFiles: RulesetFile[] = await getRulesetContent(rulesetName);
        // TODO: Need a cleaner code here.
        assert(rulesetFiles.length === 1);
        // Update firestore.rules file
        await promisify(fs.writeFile)(`terraform/${rulesetFiles[0].name}`, rulesetFiles[0].content);
        logBullet("firestore.rules generated/updated using the cloning project.");
      }

      const exportConfig: FirebaseTerraformExportMetadata = {
        projectId,
        originProjectId,
        projectDisplayName: `${originProjectMetadata.displayName}`,
        region: "nam5",
        locationId: originProjectMetadata.resources?.locationId || "us-central",
        zone: "us-central1-c", // Figure out what zone we actually used for this project?
        apis: [
          "serviceusage.googleapis.com",
          "cloudresourcemanager.googleapis.com",
          "firebase.googleapis.com",
          "identitytoolkit.googleapis.com",
          "firestore.googleapis.com",
          "firebaserules.googleapis.com",
          "firebasehosting.googleapis.com",
          "securetoken.googleapis.com",
        ]
      };


      await generateFirebaseTerraformExportConfig(exportConfig, "project_clone.tf.json");
      logBullet("terraform/project_clone.tf.json generated.");
    }
  );
