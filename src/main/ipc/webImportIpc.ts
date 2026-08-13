/* eslint-disable max-lines-per-function -- trusted handlers share one manager and registration boundary */
import { randomUUID } from "node:crypto";
import { isAppActivityUnavailableError } from "../appActivityGate";
import { runManagedAppOperation } from "../appOperationRegistry";
import { ipcEventContracts } from "../../shared/ipcContracts";
import { webImportIpcContracts } from "../../shared/ipcWebImportContracts";
import type { WebImportProgressEvent } from "../../shared/webImportTypes";
import {
  isWebImportDeadlineError,
  WebImportSessionManager,
} from "../webImportSessionManager";
import type { IpcContext } from "./context";
import { createImportPreviewSession } from "./importPreviewSessionStore";
import { trustedHandleContract } from "./trustedIpc";

export function registerWebImportIpc(context: IpcContext): void {
  const manager =
    context.webImportManager ??
    new WebImportSessionManager({ dataRoot: context.appPaths.dataRoot });

  trustedHandleContract(
    context,
    webImportIpcContracts.scanWebImport,
    async (event, request) => {
      try {
        return await runManagedAppOperation(
          context.operations,
          {
            id: `web-import-preview-${request.requestId}`,
            kind: "web-import-preview",
            mutatesLibrary: false,
          },
          (signal) =>
            manager.scan(request, signal, (progress) =>
              sendProgress(event.sender, progress),
            ),
        );
      } catch (error) {
        if (isAppActivityUnavailableError(error)) {
          return { status: "rejected" as const, reason: "busy" as const };
        }
        if (isWebImportDeadlineError(error)) {
          return { status: "rejected" as const, reason: "timed-out" as const };
        }
        throw error;
      }
    },
  );

  trustedHandleContract(
    context,
    webImportIpcContracts.cancelWebImportScan,
    async (_event, requestId) => ({
      completed: await manager.cancelScan(requestId),
    }),
  );

  trustedHandleContract(
    context,
    webImportIpcContracts.discardWebImportSession,
    async (_event, sessionId) => ({
      completed: await manager.discardSession(sessionId),
    }),
  );

  trustedHandleContract(
    context,
    webImportIpcContracts.prepareWebImport,
    async (_event, request) => {
      let cleanup: (() => Promise<void>) | undefined;
      try {
        return await runManagedAppOperation(
          context.operations,
          {
            id: `web-import-prepare-${randomUUID()}`,
            kind: "web-import-preview",
            mutatesLibrary: false,
          },
          async () => {
            const prepared = await manager.prepareImport(
              request.sessionId,
              request.selectedCandidateIds,
            );
            cleanup = prepared.cleanup;
            const session = await createImportPreviewSession(
              prepared.preview,
              undefined,
              {
                cleanup: prepared.cleanup,
                redactSourcePaths: true,
              },
            );
            cleanup = undefined;
            return session;
          },
        );
      } finally {
        await cleanup?.();
      }
    },
  );
}

function sendProgress(
  sender: {
    isDestroyed?: () => boolean;
    send?: (channel: string, payload: unknown) => void;
  },
  progress: WebImportProgressEvent,
): void {
  if (sender.isDestroyed?.() !== true) {
    sender.send?.(ipcEventContracts.webImportProgress.channel, progress);
  }
}
