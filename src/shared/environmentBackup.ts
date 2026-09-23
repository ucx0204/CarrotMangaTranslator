import { z } from "zod";

export const BACKUP_UI_KEYS = [
  "library-sort",
  "editor.activeTab.v1",
  "editor.richText.mode",
  "carrot-manga-translator.completion-sound.v1",
  "conditionalBatch.favoriteSchemeIds.v1",
] as const;
export const backupUiSchema = z.record(
  z.enum(BACKUP_UI_KEYS),
  z.string().max(100_000),
);
export type BackupUiPreferences = z.infer<typeof backupUiSchema>;
export const backupSummarySchema = z.object({
  works: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative(),
  bytes: z.number().nonnegative(),
});
export const backupPreviewSchema = backupSummarySchema.extend({
  id: z.string().uuid(),
  createdAt: z.string(),
  appVersion: z.string(),
  recoveryPath: z.string(),
  connections: z.array(z.string()),
});
export type BackupPreview = z.infer<typeof backupPreviewSchema>;
export const backupStatusSchema = z.object({
  summary: backupSummarySchema,
  recoveries: z.array(
    z.object({
      id: z.string().uuid(),
      createdAt: z.string(),
      path: z.string(),
    }),
  ),
  restored: z
    .object({
      id: z.string().uuid(),
      ui: backupUiSchema,
      connections: z.array(z.string()),
    })
    .nullable(),
});
export type BackupStatus = z.infer<typeof backupStatusSchema>;
