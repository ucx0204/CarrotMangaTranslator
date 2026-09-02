import { describe, expect, it, vi } from "vitest";
import { AppActivityGate } from "../src/main/appActivityGate";
import { AppOperationRegistry } from "../src/main/appOperationRegistry";
import {
  WebImportApplicationService,
  type WebImportPreviewSessionPort,
  type WebImportSessionPort,
} from "../src/main/application/webImportService";
import type {
  ImportPreviewResult,
  ImportPreviewSession,
} from "../src/shared/importTypes";
import type {
  WebImportProgressEvent,
  WebImportScanRequest,
  WebImportScanResponse,
} from "../src/shared/webImportTypes";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const PREVIEW_ID = "44444444-4444-4444-8444-444444444444";
const OPERATION_ID = "55555555-5555-4555-8555-555555555555";

describe("WebImportApplicationService", () => {
  it("coordinates scan progress and preserves an empty ready result", async () => {
    const progress: WebImportProgressEvent = {
      requestId: REQUEST_ID,
      stage: "loading",
      completed: 0,
      total: 0,
    };
    const scan = vi.fn<WebImportSessionPort["scan"]>(
      async (_request, _signal, onProgress) => {
        onProgress(progress);
        return readyResponse();
      },
    );
    const harness = createHarness({ scan });
    const activity = collectActivity(harness.operations);
    const onProgress = vi.fn();

    await expect(
      harness.service.scan(scanRequest(), onProgress),
    ).resolves.toEqual(readyResponse());

    expect(scan).toHaveBeenCalledWith(
      scanRequest(),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(onProgress).toHaveBeenCalledWith(progress);
    expect(activity).toEqual([
      expect.objectContaining({ status: "running", phase: "web-validating" }),
      expect.objectContaining({
        status: "running",
        phase: "web-loading",
        progressCurrent: 0,
        progressTotal: 1,
      }),
      expect.objectContaining({ status: "completed", phase: "web-loading" }),
    ]);
    expect(harness.operations.current).toBeNull();
  });

  it("maps rejected and deadline scans without changing public reasons", async () => {
    const rejected = createHarness({
      scan: async () => ({
        status: "rejected",
        reason: "private-address",
      }),
    });
    const rejectedActivity = collectActivity(rejected.operations);

    await expect(
      rejected.service.scan(scanRequest(), vi.fn()),
    ).resolves.toEqual({ status: "rejected", reason: "private-address" });
    expect(rejectedActivity.at(-1)).toMatchObject({
      status: "failed",
      failureCode: "WEB_PRIVATE_ADDRESS",
    });

    const deadlineError = new Error("deadline");
    const deadline = createHarness({
      deadlineError,
      scan: async () => {
        throw deadlineError;
      },
    });
    await expect(
      deadline.service.scan(scanRequest(), vi.fn()),
    ).resolves.toEqual({ status: "rejected", reason: "timed-out" });
  });

  it("rejects a concurrent scan as busy while the first scan owns the gate", async () => {
    let resolveFirst!: (response: WebImportScanResponse) => void;
    const scan = vi.fn<WebImportSessionPort["scan"]>(
      async () =>
        new Promise<WebImportScanResponse>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const harness = createHarness({ scan });
    const first = harness.service.scan(scanRequest(), vi.fn());
    await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());

    await expect(
      harness.service.scan(scanRequest(SECOND_REQUEST_ID), vi.fn()),
    ).resolves.toEqual({ status: "rejected", reason: "busy" });
    expect(scan).toHaveBeenCalledOnce();

    resolveFirst(readyResponse());
    await expect(first).resolves.toEqual(readyResponse());
  });

  it("keeps operation cancellation and terminal activity ordering", async () => {
    const scan = vi.fn<WebImportSessionPort["scan"]>(
      async (_request, signal) =>
        new Promise<WebImportScanResponse>((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ status: "rejected", reason: "cancelled" }),
            { once: true },
          );
        }),
    );
    const harness = createHarness({ scan });
    const activity = collectActivity(harness.operations);
    const pending = harness.service.scan(scanRequest(), vi.fn());
    await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());

    expect(
      harness.operations.requestCancel(`web-import-preview-${REQUEST_ID}`),
    ).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(activity.at(-2)).toMatchObject({ status: "cancelling" });
    expect(activity.at(-1)).toMatchObject({ status: "cancelled" });
    expect(harness.operations.current).toBeNull();
  });

  it("transfers prepared cleanup ownership only after preview publication", async () => {
    const cleanup = vi.fn(async () => undefined);
    const prepareImport = vi.fn<WebImportSessionPort["prepareImport"]>(
      async (_sessionId, _selectedIds, _signal, onProgress) => {
        onProgress?.(0, 0);
        onProgress?.(1, 1);
        return { preview: importPreview(), cleanup };
      },
    );
    const previewCreate = vi.fn<WebImportPreviewSessionPort["create"]>(
      async (preview) => ({ ...preview, previewId: PREVIEW_ID }),
    );
    const harness = createHarness({ prepareImport, previewCreate });
    const activity = collectActivity(harness.operations);

    await expect(
      harness.service.prepare({
        sessionId: SESSION_ID,
        selectedCandidateIds: ["candidate-1"],
      }),
    ).resolves.toEqual(importPreviewSession());

    expect(prepareImport).toHaveBeenCalledWith(
      SESSION_ID,
      ["candidate-1"],
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(previewCreate).toHaveBeenCalledWith(importPreview(), {
      cleanup,
      redactSourcePaths: true,
    });
    expect(cleanup).not.toHaveBeenCalled();
    expect(activity).toEqual([
      expect.objectContaining({
        id: `web-import-prepare-${OPERATION_ID}`,
        status: "running",
        progressCurrent: 0,
        progressTotal: 1,
      }),
      expect.objectContaining({ status: "running", progressTotal: 1 }),
      expect.objectContaining({
        status: "running",
        progressCurrent: 1,
        progressTotal: 1,
      }),
      expect.objectContaining({ status: "completed" }),
    ]);
  });

  it("cleans prepared files if preview publication or cleanup fails", async () => {
    const publicationError = new Error("preview publication failed");
    const cleanup = vi.fn(async () => undefined);
    const publication = createHarness({
      prepareImport: async () => ({ preview: importPreview(), cleanup }),
      previewCreate: async () => {
        throw publicationError;
      },
    });

    await expect(
      publication.service.prepare({
        sessionId: SESSION_ID,
        selectedCandidateIds: ["candidate-1"],
      }),
    ).rejects.toBe(publicationError);
    expect(cleanup).toHaveBeenCalledOnce();

    const cleanupError = new Error("cleanup failed");
    const failingCleanup = vi.fn(async () => {
      throw cleanupError;
    });
    const cleanupFailure = createHarness({
      prepareImport: async () => ({
        preview: importPreview(),
        cleanup: failingCleanup,
      }),
      previewCreate: async () => {
        throw publicationError;
      },
    });
    await expect(
      cleanupFailure.service.prepare({
        sessionId: SESSION_ID,
        selectedCandidateIds: ["candidate-1"],
      }),
    ).rejects.toBe(cleanupError);
    expect(failingCleanup).toHaveBeenCalledOnce();
  });

  it("delegates cancellation and session discard through the port", async () => {
    const cancelScan = vi.fn(async () => true);
    const discardSession = vi.fn(async () => false);
    const harness = createHarness({ cancelScan, discardSession });

    await expect(harness.service.cancelScan(REQUEST_ID)).resolves.toEqual({
      completed: true,
    });
    await expect(harness.service.discardSession(SESSION_ID)).resolves.toEqual({
      completed: false,
    });
    expect(cancelScan).toHaveBeenCalledWith(REQUEST_ID);
    expect(discardSession).toHaveBeenCalledWith(SESSION_ID);
  });
});

type HarnessOptions = Partial<WebImportSessionPort> & {
  previewCreate?: WebImportPreviewSessionPort["create"];
  deadlineError?: unknown;
};

function createHarness(options: HarnessOptions = {}) {
  const activityGate = new AppActivityGate();
  const operations = new AppOperationRegistry(activityGate);
  const sessions: WebImportSessionPort = {
    scan: async () => readyResponse(),
    cancelScan: async () => false,
    discardSession: async () => false,
    prepareImport: async () => ({ preview: importPreview() }),
    ...options,
  };
  const previewSessions: WebImportPreviewSessionPort = {
    create:
      options.previewCreate ??
      (async (preview) => ({ ...preview, previewId: PREVIEW_ID })),
  };
  return {
    operations,
    sessions,
    previewSessions,
    service: new WebImportApplicationService({
      operations,
      sessions,
      previewSessions,
      createOperationId: () => OPERATION_ID,
      isDeadlineError: (error) => error === options.deadlineError,
    }),
  };
}

function collectActivity(operations: AppOperationRegistry) {
  const activity: Array<{
    id: string;
    status: string;
    phase?: string;
    progressCurrent?: number;
    progressTotal?: number;
    failureCode?: string;
  }> = [];
  operations.subscribeActivity((event) => activity.push(event));
  return activity;
}

function scanRequest(requestId = REQUEST_ID): WebImportScanRequest {
  return { requestId, url: "https://example.com/chapter" };
}

function readyResponse(): WebImportScanResponse {
  return {
    status: "ready",
    result: {
      sessionId: SESSION_ID,
      pageTitle: "Web chapter",
      sourceHost: "example.com",
      candidates: [],
      skipped: { unsupported: 0, failed: 0, duplicate: 0, blocked: 0 },
      truncated: false,
    },
  };
}

function importPreview(): ImportPreviewResult {
  return {
    mode: "single",
    sourceKind: "images",
    suggestedWorkTitle: "Prepared web chapter",
    chapters: [],
  };
}

function importPreviewSession(): ImportPreviewSession {
  return { ...importPreview(), previewId: PREVIEW_ID };
}
