import { randomUUID } from "node:crypto";
import { app, dialog } from "electron";
import type { IpcContext } from "../ipc/context";
import { EnvironmentBackupService } from "../application/environmentBackupService";
import type { EnvironmentBackupPorts } from "../application/environmentBackupService";
import { libraryMutationCoordinator } from "../library";
import { isAbortErrorLike } from "../abortSignal";
import { EnvironmentBackupStore } from "./store";
import { suspendEnvironmentAccess } from "./access";

export function createEnvironmentBackupService(
  context: IpcContext,
): EnvironmentBackupService {
  const store = new EnvironmentBackupStore(context.appPaths, app.getVersion());
  return new EnvironmentBackupService({
    discard: (id) => store.discard(id),
    receipt: () => store.receipt(),
    status: () => store.status(),
    pickExport: async () => {
      const result = await dialog.showSaveDialog({
        defaultPath: `Carrot-backup-${new Date().toISOString().slice(0, 10)}.zip`,
        filters: [{ name: "Carrot environment backup", extensions: ["zip"] }],
      });
      return result.canceled ? null : (result.filePath ?? null);
    },
    pickImport: async () => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [{ name: "Carrot environment backup", extensions: ["zip"] }],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    exclusive: createExclusiveOperation(context),
    export: (...args) => store.export(...args),
    preview: (...args) => store.preview(...args),
    prepareRecovery: (...args) => store.prepareRecovery(...args),
    schedule: (...args) => store.schedule(...args),
    restart: () => {
      app.relaunch();
      setImmediate(() => app.quit());
    },
  });
}

function createExclusiveOperation(
  context: IpcContext,
): EnvironmentBackupPorts["exclusive"] {
  return async (kind, action) => {
    const lease = context.operations.begin({
      id: randomUUID(),
      kind,
      mutatesLibrary: true,
      presentation: {
        phase:
          kind === "environment-backup" ? "share-packaging" : "share-reading",
        cancellable: true,
        progressUnit: kind === "environment-backup" ? "items" : "bytes",
      },
    });
    let releaseAccess: (() => void) | undefined;
    let releaseMutations: (() => void) | undefined;
    let sealed = false;
    try {
      releaseAccess = await suspendEnvironmentAccess();
      const suspension = libraryMutationCoordinator.suspendNewMutations();
      releaseMutations = () => suspension.release();
      await libraryMutationCoordinator.waitForIdle();
      const result = await action(
        lease.signal,
        (current, total) =>
          lease.updateActivity({
            progressCurrent: current,
            progressTotal: total,
          }),
        () => {
          lease.signal.throwIfAborted();
          sealed = true;
          lease.updateActivity({ cancellable: false, phase: "share-applying" });
        },
      );
      // A scheduled restore must keep all writers stopped until the process exits.
      lease.finish("completed");
      return result;
    } catch (error) {
      sealed = false;
      lease.finish(isAbortErrorLike(error) ? "cancelled" : "failed");
      throw error;
    } finally {
      if (!sealed) {
        releaseMutations?.();
        releaseAccess?.();
      }
    }
  };
}
