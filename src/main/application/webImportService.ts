import type {
  ImportPreviewResult,
  ImportPreviewSession,
  PreparedImportPreview,
} from "../../shared/importTypes";
import type {
  PrepareWebImportRequest,
  WebImportBooleanResult,
  WebImportProgressEvent,
  WebImportScanRequest,
  WebImportScanResponse,
} from "../../shared/webImportTypes";
import { isAppActivityUnavailableError } from "../appActivityGate";
import {
  runManagedAppOperation,
  type AppOperationLease,
  type AppOperationRegistry,
} from "../appOperationRegistry";
import { throwIfAborted } from "../abortSignal";

export type WebImportSessionPort = {
  scan: (
    request: WebImportScanRequest,
    signal: AbortSignal,
    onProgress: (event: WebImportProgressEvent) => void,
  ) => Promise<WebImportScanResponse>;
  cancelScan: (requestId: string) => Promise<boolean>;
  discardSession: (sessionId: string) => Promise<boolean>;
  prepareImport: (
    sessionId: string,
    selectedCandidateIds: readonly string[],
    signal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
  ) => Promise<PreparedImportPreview>;
};

export type WebImportPreviewSessionPort = {
  create: (
    preview: ImportPreviewResult,
    options: {
      cleanup?: () => Promise<void>;
      redactSourcePaths: true;
    },
  ) => Promise<ImportPreviewSession>;
};

export type WebImportApplicationServiceOptions = {
  operations: AppOperationRegistry;
  sessions: WebImportSessionPort;
  previewSessions: WebImportPreviewSessionPort;
  createOperationId: () => string;
  isDeadlineError: (error: unknown) => boolean;
};

export class WebImportApplicationService {
  constructor(private readonly options: WebImportApplicationServiceOptions) {}

  async scan(
    request: WebImportScanRequest,
    onProgress: (event: WebImportProgressEvent) => void,
  ): Promise<WebImportScanResponse> {
    try {
      return await runManagedAppOperation(
        this.options.operations,
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
          const response = await this.options.sessions.scan(
            request,
            signal,
            (progress) => {
              operation.updateActivity({
                phase: webProgressPhase(progress.stage),
                progressCurrent: progress.completed,
                progressTotal: Math.max(1, progress.total),
                progressUnit: "items",
              });
              onProgress(progress);
            },
          );
          throwIfAborted(signal);
          finishRejectedScan(operation, response);
          return response;
        },
      );
    } catch (error) {
      if (isAppActivityUnavailableError(error)) {
        return { status: "rejected", reason: "busy" };
      }
      if (this.options.isDeadlineError(error)) {
        return { status: "rejected", reason: "timed-out" };
      }
      throw error;
    }
  }

  async cancelScan(requestId: string): Promise<WebImportBooleanResult> {
    return { completed: await this.options.sessions.cancelScan(requestId) };
  }

  async discardSession(sessionId: string): Promise<WebImportBooleanResult> {
    return {
      completed: await this.options.sessions.discardSession(sessionId),
    };
  }

  async prepare(
    request: PrepareWebImportRequest,
  ): Promise<ImportPreviewSession> {
    let cleanup: (() => Promise<void>) | undefined;
    try {
      return await runManagedAppOperation(
        this.options.operations,
        {
          id: `web-import-prepare-${this.options.createOperationId()}`,
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
          const prepared = await this.options.sessions.prepareImport(
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
          const session = await this.options.previewSessions.create(
            prepared.preview,
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
  }
}

function finishRejectedScan(
  operation: AppOperationLease,
  response: WebImportScanResponse,
): void {
  if (response.status !== "rejected") return;
  operation.finish(
    response.reason === "cancelled" ? "cancelled" : "failed",
    response.reason === "cancelled"
      ? undefined
      : `WEB_${response.reason.replace(/-/g, "_").toUpperCase()}`,
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
