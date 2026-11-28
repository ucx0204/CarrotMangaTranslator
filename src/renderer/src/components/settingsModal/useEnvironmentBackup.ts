import React from "react";
import type {
  BackupPreview,
  BackupStatus,
  GlossaryTargets,
} from "../../../../shared/environmentBackup";
import type { AppOperationActivityEvent } from "../../../../shared/appOperationTypes";
import { environmentBackupGateway as gateway } from "../../api/environmentBackupGateway";
import { readBackupPreferences } from "../../lib/environmentBackupPreferences";
import {
  isAppOperationActive,
  isBackupPreviewReady,
} from "../../lib/appOperationPresentation";
import { pendingPageEdits } from "../../lib/pageEditBarrier";

export function useEnvironmentBackup() {
  const [status, setStatus] = React.useState<BackupStatus | null>(null);
  // An explicit local choice takes precedence over an earlier status request.
  const [selectedPreview, setPreview] = React.useState<BackupPreview | null>();
  const preview =
    selectedPreview === undefined
      ? (status?.pendingPreview ?? null)
      : selectedPreview;
  const [recoveryId, setRecoveryId] = React.useState<string | null>(null);
  const [activity, setActivity] =
    React.useState<AppOperationActivityEvent | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [savedPath, setSavedPath] = React.useState("");
  const chooseRecovery = (id: string | null) => {
    if (preview)
      void gateway
        .discardEnvironmentBackup(preview.id)
        .catch((cause: unknown) => setError(String(cause)));
    setPreview(null);
    setRecoveryId(id);
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
    busy: busy || isAppOperationActive(activity),
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
    chooseRecovery,
    dismiss: () => chooseRecovery(null),
    apply: (targets: GlossaryTargets = []) =>
      run(async () => {
        if (preview)
          await gateway.restoreEnvironmentBackup(
            preview.id,
            readBackupPreferences(),
            ...(preview.partial ? ([targets] as const) : []),
          );
        else if (recoveryId)
          await gateway.recoverEnvironmentBackup(
            recoveryId,
            readBackupPreferences(),
          );
        setPreview(null);
        setRecoveryId(null);
      }),
    cancel: () => cancelBackupActivity(activity, setError),
  };
}

function useBackupSubscription(
  setStatus: React.Dispatch<React.SetStateAction<BackupStatus | null>>,
  setActivity: React.Dispatch<
    React.SetStateAction<AppOperationActivityEvent | null>
  >,
  setError: React.Dispatch<React.SetStateAction<string>>,
): void {
  React.useEffect(() => {
    let mounted = true;
    let revision = 0;
    let receivedActivity = false;
    function refreshStatus() {
      const request = ++revision;
      void gateway.getEnvironmentBackupStatus().then(
        (status) => {
          if (mounted && request === revision) setStatus(status);
        },
        (cause: unknown) => {
          if (mounted && request === revision) setError(String(cause));
        },
      );
    }
    const unsubscribe = gateway.onAppOperationActivity((event) => {
      if (!isBackupOperation(event)) return;
      receivedActivity = true;
      setActivity(event);
      if (isBackupPreviewReady(event)) refreshStatus();
    });
    refreshStatus();
    void gateway.getActiveAppOperations().then(
      (events) => {
        if (mounted && !receivedActivity)
          setActivity(events.find(isBackupOperation) ?? null);
      },
      (cause: unknown) => {
        if (mounted) setError(String(cause));
      },
    );
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [setStatus, setActivity, setError]);
}

function isBackupOperation(event: AppOperationActivityEvent): boolean {
  return (
    event.kind === "environment-backup" ||
    event.kind === "environment-backup-preview" ||
    event.kind === "environment-restore"
  );
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
