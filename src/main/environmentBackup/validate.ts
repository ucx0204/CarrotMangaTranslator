import { join } from "node:path";
import { BlockLibrarySnapshotV1Schema } from "../../shared/blockLibrary";
import { FontLibrarySnapshotSchema } from "../../shared/ipcContextSettingsContracts";
import { ConditionalBatchSchemeStore } from "../conditionalBatchSchemeStore";
import { readPageWorkflowRun } from "../pageWorkflowRunStore";
import { exists, readBackupJson, regularFiles } from "./files";
import { backupRelativePath } from "./policy";

export async function validateBackupUserStores(root: string): Promise<void> {
  const blocks = join(root, "block-library.json");
  if (await exists(blocks))
    BlockLibrarySnapshotV1Schema.parse(await readBackupJson(blocks));
  await new ConditionalBatchSchemeStore(root).list();
  const workflows = join(root, "page-workflows");
  if (await exists(workflows))
    for (const file of await regularFiles(workflows)) {
      if (!file.endsWith(".json"))
        throw new Error("Invalid workflow run file.");
      const id = file.slice(0, -5);
      const run = await readPageWorkflowRun(root, id);
      if (run.id !== id) throw new Error("Workflow run identity mismatch.");
    }
  const fontIndex = join(root, "fonts/index.json");
  if (await exists(fontIndex)) {
    const fonts = FontLibrarySnapshotSchema.shape.customFonts.parse(
      await readBackupJson(fontIndex),
    );
    for (const font of fonts) {
      backupRelativePath(font.fileName);
      if (
        font.fileName.includes("/") ||
        !(await exists(join(root, "fonts", font.fileName)))
      )
        throw new Error("A custom font file is missing.");
    }
  }
  const preferences = join(root, "fonts/preferences.json");
  if (await exists(preferences))
    FontLibrarySnapshotSchema.shape.preferences.parse(
      await readBackupJson(preferences),
    );
}
