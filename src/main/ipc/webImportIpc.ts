/* eslint-disable max-lines-per-function -- trusted handlers share one manager and registration boundary */
import { randomUUID } from "node:crypto";
import { isAppActivityUnavailableError } from "../appActivityGate";
import { runManagedAppOperation } from "../appOperationRegistry";
import { ipcEventContracts } from "../../shared/ipcContracts";
import { webImportIpcContracts } from "../../shared/ipcWebImportContracts";
import type { WebImportProgressEvent } from "../../shared/webImportTypes";
import { throwIfAborted } from "../abortSignal";
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
            presentation: {
              phase: "web-validating",
              cancellable: true,
            },
          },
          async (signal, operation) => {
            const response = await manager.scan(request, signal, (progress) => {
              operation.updateActivity({
                phase: webProgressPhase(progress.stage),
                progressCurrent: progress.completed,
                progressTotal: Math.max(1, progress.total),
                progressUnit: "items",
              });
              sendProgress(event.sender, progress);
            });
            throwIfAborted(signal);
            if (response.status === "rejected") {
              operation.finish(
                response.reason === "cancelled" ? "cancelled" : "failed",
                response.reason === "cancelled"
                  ? undefined
                  : `WEB_${response.reason.replace(/-/g, "_").toUpperCase()}`,
              );
            }
            return response;
          },
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
            presentation: {
              phase: "web-preparing",
              cancellable: true,
              progressCurrent: 0,
              progressTotal: request.selectedCandidateIds.length,
              progressUnit: "items",
            },
          },
          async (signal, operation) => {
            const prepared = await manager.prepareImport(
              request.sessionId,
              request.selectedCandidateIds,
              signal,
              (completed, total) =>
                operation.updateActivity({
                  phase: "web-preparing",
                  progressCurrent: completed,
                  progressTotal: Math.max(1, total),
                  progressUnit: "items",
                }),
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

function webProgressPhase(
  stage: WebImportProgressEvent["stage"],
):
  | "web-validating"
  | "web-loading"
  | "web-scrolling"
  | "web-discovering"
  | "web-downloading" {
  return `web-${stage}`;
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
