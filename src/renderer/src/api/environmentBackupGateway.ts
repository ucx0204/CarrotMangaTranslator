import { createMangaDomainGateway } from "./mangaGateway";

export const environmentBackupGateway = createMangaDomainGateway(
  "Environment backup",
  [
    "discardEnvironmentBackup",
    "getEnvironmentRestoreReceipt",
    "getEnvironmentBackupStatus",
    "exportEnvironmentBackup",
    "previewEnvironmentBackup",
    "restoreEnvironmentBackup",
    "recoverEnvironmentBackup",
    "onAppOperationActivity",
    "getActiveAppOperations",
    "cancelAppOperation",
  ] as const,
);
