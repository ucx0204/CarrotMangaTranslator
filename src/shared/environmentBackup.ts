import { z } from "zod";

export type BackupProgress = (
  current: number,
  total: number,
  phase?:
    | "backup-copying"
    | "backup-verifying"
    | "backup-compressing"
    | "import-finalizing",
) => void;

export const BACKUP_UI_KEYS = [
  "library-sort",
  "editor.activeTab.v1",
  "editor.richText.mode",
  "carrot-manga-translator.completion-sound.v1",
  "conditionalBatch.favoriteSchemeIds.v1",
  "workspace.preferences.v1",
  "library.collapsedWorkIds.v1",
] as const;
export const backupUiSchema = z.partialRecord(
  z.enum(BACKUP_UI_KEYS),
  z.string().max(100_000),
);
export type BackupUiPreferences = z.infer<typeof backupUiSchema>;
export const backupSummarySchema = z.object({
  works: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative(),
  bytes: z.number().nonnegative(),
});
const recoveredWorkSchema = z.object({
  sourceId: z.string(),
  title: z.string(),
  chapters: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative(),
  terms: z.number().int().nonnegative(),
  sample: z.array(z.string()).max(3).optional(),
});
export type RecoveredWork = z.infer<typeof recoveredWorkSchema>;
export const glossaryTargetsSchema = z.array(
  z.object({
    sourceId: z.string().min(1).max(200),
    workId: z.string().min(1).max(200),
  }),
);
export type GlossaryTargets = z.infer<typeof glossaryTargetsSchema>;
export const backupPreviewSchema = backupSummarySchema.extend({
  id: z.string().uuid(),
  createdAt: z.string(),
  appVersion: z.string(),
  recoveryPath: z.string(),
  connections: z.array(z.string()),
  partial: z
    .object({
      items: z.array(recoveredWorkSchema),
      targets: z.array(z.object({ id: z.string(), title: z.string() })),
      issues: z.array(z.string()),
      issueCount: z.number().int().nonnegative(),
    })
    .optional(),
});
export type BackupPreview = z.infer<typeof backupPreviewSchema>;
export const backupStatusSchema = z.object({
  summary: backupSummarySchema,
  pendingPreview: backupPreviewSchema.nullable().optional(),
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
