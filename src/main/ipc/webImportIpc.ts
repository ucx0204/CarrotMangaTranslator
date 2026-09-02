import { randomUUID } from "node:crypto";
import { ipcEventContracts } from "../../shared/ipcContracts";
import { webImportIpcContracts } from "../../shared/ipcWebImportContracts";
import type { WebImportProgressEvent } from "../../shared/webImportTypes";
import { WebImportApplicationService } from "../application/webImportService";
import {
  isWebImportDeadlineError,
  WebImportSessionManager,
} from "../webImportSessionManager";
import type { IpcContext } from "./context";
import { createImportPreviewSession } from "./importPreviewSessionStore";
import { trustedHandleContract } from "./trustedIpc";

export function registerWebImportIpc(context: IpcContext): void {
  const service = createWebImportService(context);

  trustedHandleContract(
    context,
    webImportIpcContracts.scanWebImport,
    async (event, request) =>
      service.scan(request, (progress) => sendProgress(event.sender, progress)),
  );

  trustedHandleContract(
    context,
    webImportIpcContracts.cancelWebImportScan,
    async (_event, requestId) => service.cancelScan(requestId),
  );

  trustedHandleContract(
    context,
    webImportIpcContracts.discardWebImportSession,
    async (_event, sessionId) => service.discardSession(sessionId),
  );

  trustedHandleContract(
    context,
    webImportIpcContracts.prepareWebImport,
    async (_event, request) => service.prepare(request),
  );
}

function createWebImportService(
  context: IpcContext,
): WebImportApplicationService {
  const sessions =
    context.webImportManager ??
    new WebImportSessionManager({ dataRoot: context.appPaths.dataRoot });
  return new WebImportApplicationService({
    operations: context.operations,
    sessions,
    previewSessions: {
      create: (preview, options) =>
        createImportPreviewSession(preview, undefined, options),
    },
    createOperationId: randomUUID,
    isDeadlineError: isWebImportDeadlineError,
  });
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
