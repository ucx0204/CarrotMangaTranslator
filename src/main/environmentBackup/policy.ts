import { z } from "zod";
import {
  backupSummarySchema,
  backupUiSchema,
} from "../../shared/environmentBackup";
import { normalizeShareRelativePath } from "../libraryStore/zipSafety";

const BACKUP_DATA_NAMES = [
  "library",
  "fonts",
  "block-library.json",
  "batch-edit-schemes.yaml",
  "image-redactions.json",
  "manual-redaction-workspaces.json",
  "manual-redaction-drafts",
  "page-workflows",
] as const;
export const BACKUP_SOURCE_NAMES = [
  "library/index.json",
  "library/works",
  ...BACKUP_DATA_NAMES.filter((name) => name !== "library"),
];
export const RESTORE_NAMES = [
  ...BACKUP_DATA_NAMES,
  "settings.json",
  "settings.secrets.json",
  "settings.commit.json",
  ".settings-pairs",
  "linked-workspaces.json",
  "linked-sync-queue.json",
  "codex",
  "migration-ui.json",
] as const;
export const MAX_BACKUP_BYTES = 1024 ** 4;
export const MAX_BACKUP_FILES = 1_000_000;
export const MAX_BACKUP_JSON_BYTES = 128 * 1024 ** 2;
const inventoryEntrySchema = z
  .object({
    path: z.string().max(4096),
    size: z
      .number()
      .int()
      .nonnegative()
      .max(32 * 1024 ** 3),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const backupManifestSchema = z
  .object({
    format: z.literal("carrot-environment-backup"),
    version: z.literal(1),
    appVersion: z.string().min(1).max(100),
    createdAt: z.string().datetime(),
    summary: backupSummarySchema,
    ui: backupUiSchema,
    connections: z.array(z.string().max(4096)).max(2000),
    files: z.array(inventoryEntrySchema).max(MAX_BACKUP_FILES),
  })
  .strict();
export type BackupManifest = z.infer<typeof backupManifestSchema>;
export type BackupInventoryEntry = z.infer<typeof inventoryEntrySchema>;

export function backupRelativePath(path: string): string {
  const normalized = normalizeShareRelativePath(path, "Invalid backup path");
  if (
    normalized !== path ||
    path
      .split("/")
      .some(
        (part) =>
          /[<>:"|?*\x00-\x1f]|[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error("Backup contains a non-portable path.");
  return normalized;
}

export function assertBackupPayloadPath(path: string): void {
  backupRelativePath(path);
  const root = path.split("/")[0];
  if (
    root !== "portable-settings.json" &&
    !BACKUP_DATA_NAMES.some((name) => name === root)
  )
    throw new Error("Backup contains an unsupported data category.");
  if (
    root === "library" &&
    path !== "library/index.json" &&
    !path.startsWith("library/works/")
  )
    throw new Error("Backup contains unsupported library metadata.");
  if (root.endsWith(".json") || root.endsWith(".yaml")) {
    if (path !== root)
      throw new Error("A backup document cannot be a directory.");
  }
}
