import {
  BACKUP_UI_KEYS,
  backupUiSchema,
  type BackupUiPreferences,
} from "../../../shared/environmentBackup";
import { toast } from "./toastStore";
import { appI18n } from "../appI18n";
import { environmentBackupGateway } from "../api/environmentBackupGateway";
import type { TFunction } from "i18next";

export function readBackupPreferences(
  storage: Storage = window.localStorage,
): BackupUiPreferences {
  return backupUiSchema.parse(
    Object.fromEntries(
      BACKUP_UI_KEYS.flatMap((key) => {
        const value = storage.getItem(key);
        return value === null ? [] : [[key, value]];
      }),
    ),
  );
}
export async function restoreBackupPreferences(): Promise<void> {
  const restored =
    await environmentBackupGateway.getEnvironmentRestoreReceipt();
  if (
    !restored ||
    window.localStorage.getItem("environment-backup.applied") === restored.id
  )
    return;
  for (const key of BACKUP_UI_KEYS) {
    const value = restored.ui[key];
    if (value === undefined) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  }
  window.localStorage.setItem("environment-backup.applied", restored.id);
  notifyRestored(appI18n.getFixedT(null, "components"));
}

function notifyRestored(t: TFunction<"components">): void {
  toast.info(t("settings.backup.restored"), { duration: 0 });
}
