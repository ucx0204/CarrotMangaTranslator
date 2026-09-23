import { z } from "zod";
import { defineIpcContract } from "./ipcContractCore";
import type {
  BackupPreview,
  BackupStatus,
  BackupUiPreferences,
} from "./environmentBackup";
import {
  backupPreviewSchema,
  backupStatusSchema,
  backupUiSchema,
} from "./environmentBackup";

export const environmentBackupIpcContracts = {
  discardEnvironmentBackup: defineIpcContract<[string], null>({
    apiKey: "discardEnvironmentBackup",
    channel: "environment-backup:discard",
    args: z.tuple([z.string().uuid()]),
    result: z.null(),
  }),
  getEnvironmentRestoreReceipt: defineIpcContract<[], BackupStatus["restored"]>(
    {
      apiKey: "getEnvironmentRestoreReceipt",
      channel: "environment-backup:receipt",
      args: z.tuple([]),
      result: backupStatusSchema.shape.restored,
    },
  ),
  getEnvironmentBackupStatus: defineIpcContract<[], BackupStatus>({
    apiKey: "getEnvironmentBackupStatus",
    channel: "environment-backup:status",
    args: z.tuple([]),
    result: backupStatusSchema,
  }),
  exportEnvironmentBackup: defineIpcContract<
    [BackupUiPreferences],
    string | null
  >({
    apiKey: "exportEnvironmentBackup",
    channel: "environment-backup:export",
    args: z.tuple([backupUiSchema]),
    result: z.string().nullable(),
  }),
  previewEnvironmentBackup: defineIpcContract<[], BackupPreview | null>({
    apiKey: "previewEnvironmentBackup",
    channel: "environment-backup:preview",
    args: z.tuple([]),
    result: backupPreviewSchema.nullable(),
  }),
  restoreEnvironmentBackup: defineIpcContract<
    [string, BackupUiPreferences],
    null
  >({
    apiKey: "restoreEnvironmentBackup",
    channel: "environment-backup:restore",
    args: z.tuple([z.string().uuid(), backupUiSchema]),
    result: z.null(),
  }),
  recoverEnvironmentBackup: defineIpcContract<
    [string, BackupUiPreferences],
    null
  >({
    apiKey: "recoverEnvironmentBackup",
    channel: "environment-backup:recover",
    args: z.tuple([z.string().uuid(), backupUiSchema]),
    result: z.null(),
  }),
};
