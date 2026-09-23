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
    "cancelAppOperation",
  ] as const,
);
