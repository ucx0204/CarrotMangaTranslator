import React from "react";
import type {
  BackupPreview,
  BackupStatus,
} from "../../../../shared/environmentBackup";
import type { AppOperationActivityEvent } from "../../../../shared/appOperationTypes";
import { environmentBackupGateway as gateway } from "../../api/environmentBackupGateway";
import { readBackupPreferences } from "../../lib/environmentBackupPreferences";
import { pendingPageEdits } from "../../lib/pageEditBarrier";

export function useEnvironmentBackup() {
  const [status, setStatus] = React.useState<BackupStatus | null>(null);
  const [preview, setPreview] = React.useState<BackupPreview | null>(null);
  const [recoveryId, setRecoveryId] = React.useState<string | null>(null);
  const [activity, setActivity] =
    React.useState<AppOperationActivityEvent | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [savedPath, setSavedPath] = React.useState("");
  useDiscardPreviewOnUnmount(preview);
  const discard = () => {
    if (preview)
      void gateway
        .discardEnvironmentBackup(preview.id)
        .catch((cause: unknown) => setError(String(cause)));
  };
  useBackupSubscription(setStatus, setActivity, setError);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setSavedPath("");
    setActivity(null);
    try {
      await pendingPageEdits.flushEnvironment();
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return {
    status,
    preview,
    recoveryId,
    activity,
    busy,
    error,
    savedPath,
    exportBackup: () =>
      run(async () => {
        setSavedPath(
          (await gateway.exportEnvironmentBackup(readBackupPreferences())) ??
            "",
        );
      }),
    inspectBackup: () =>
      run(async () => {
        setRecoveryId(null);
        setPreview(await gateway.previewEnvironmentBackup());
      }),
    chooseRecovery: (id: string) => {
      discard();
      setPreview(null);
      setRecoveryId(id);
    },
    dismiss: () => {
      discard();
      setPreview(null);
      setRecoveryId(null);
    },
    apply: () =>
      run(async () => {
        if (preview)
          await gateway.restoreEnvironmentBackup(
            preview.id,
            readBackupPreferences(),
          );
        else if (recoveryId)
          await gateway.recoverEnvironmentBackup(
            recoveryId,
            readBackupPreferences(),
          );
      }),
    cancel: () => cancelBackupActivity(activity, setError),
  };
}

function useDiscardPreviewOnUnmount(preview: BackupPreview | null): void {
  const id = preview?.id;
  React.useEffect(
    () => () => {
      if (id)
        void gateway
          .discardEnvironmentBackup(id)
          .catch((error: unknown) =>
            console.error("Backup preview cleanup failed", error),
          );
    },
    [id],
  );
}

function useBackupSubscription(
  setStatus: React.Dispatch<React.SetStateAction<BackupStatus | null>>,
  setActivity: React.Dispatch<
    React.SetStateAction<AppOperationActivityEvent | null>
  >,
  setError: React.Dispatch<React.SetStateAction<string>>,
): void {
  React.useEffect(() => {
    void gateway
      .getEnvironmentBackupStatus()
      .then(setStatus)
      .catch((cause: unknown) => setError(String(cause)));
    return gateway.onAppOperationActivity((event) => {
      if (
        event.kind === "environment-backup" ||
        event.kind === "environment-restore"
      )
        setActivity(event);
    });
  }, [setStatus, setActivity, setError]);
}

function cancelBackupActivity(
  activity: AppOperationActivityEvent | null,
  setError: (value: string) => void,
): void {
  if (activity)
    void gateway
      .cancelAppOperation(activity.id)
      .catch((cause: unknown) => setError(String(cause)));
}
