import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppActivityGate } from "../src/main/appActivityGate";
import { AppOperationRegistry } from "../src/main/appOperationRegistry";
import { runAppQuitCleanup } from "../src/main/appQuitCleanup";
import {
  APP_QUIT_HARD_DEADLINE_MS,
  beginBoundedAppQuit,
  type AppQuitCleanupProgress,
} from "../src/main/appQuitCoordinator";

afterEach(() => {
  vi.useRealTimers();
});

describe("managed operation app quit cleanup", () => {
  it("aborts and waits for operation finish before runtime disposal", async () => {
    const operations = new AppOperationRegistry(new AppActivityGate());
    const lease = operations.begin({
      id: "library-import-preview-id",
      kind: "library-import",
      mutatesLibrary: true,
    });
    const progress: AppQuitCleanupProgress[] = [];
    const disposeInpainting = vi.fn(async () => undefined);
    const disposeTranslation = vi.fn(async () => undefined);
    const releaseInpaintingHistory = vi.fn(async () => 0);

    const cleanup = runAppQuitCleanup({
      jobs: idleJobs(),
      operations,
      cancelStartupMaintenance: vi.fn(),
      disposeInpainting,
      disposeTranslation,
      releaseInpaintingHistory,
      updateProgress: (next) => progress.push(next),
      logError: vi.fn(),
      logWarn: vi.fn(),
    });

    await Promise.resolve();
    expect(lease.signal.aborted).toBe(true);
    expect(disposeInpainting).not.toHaveBeenCalled();
    expect(disposeTranslation).not.toHaveBeenCalled();

    lease.finish();
    await cleanup;

    expect(progress).toEqual([
      { stage: "startup-maintenance-cancel" },
      {
        stage: "managed-operation-cleanup",
        operationId: "library-import-preview-id",
        operationKind: "library-import",
      },
      { stage: "runtime-resource-disposal" },
      { stage: "inpainting-history-release" },
    ]);
    expect(disposeInpainting).toHaveBeenCalledTimes(1);
    expect(disposeTranslation).toHaveBeenCalledTimes(1);
    expect(releaseInpaintingHistory).toHaveBeenCalledTimes(1);
  });

  it("closes activity intake in index before bounded quit begins", () => {
    const source = readFileSync("src/main/index.ts", "utf8");
    const closeIndex = source.indexOf("appActivityGate.closeToNewActivities()");
    const quitIndex = source.indexOf("beginBoundedAppQuit({", closeIndex);

    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(quitIndex).toBeGreaterThan(closeIndex);
    expect(source.slice(closeIndex, quitIndex)).not.toContain("await ");
  });

  it("reports managed operation metadata when the hard deadline forces exit", async () => {
    vi.useFakeTimers();
    const forcedExit = vi.fn();
    const reportForcedExit = vi.fn();

    beginBoundedAppQuit({
      runCleanup: async (updateProgress) => {
        updateProgress({
          stage: "managed-operation-cleanup",
          operationId: "hung-operation",
          operationKind: "work-share-import",
        });
        await new Promise<void>(() => {});
      },
      runtime: {
        now: () => Date.now(),
        schedule: (callback, delayMs) => setTimeout(callback, delayMs),
        gracefulQuit: vi.fn(),
        forceExit: forcedExit,
        reportCleanupFailure: vi.fn(),
        reportForcedExit,
      },
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(APP_QUIT_HARD_DEADLINE_MS);

    expect(forcedExit).toHaveBeenCalledWith(0);
    expect(reportForcedExit).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "hard-deadline",
        stage: "managed-operation-cleanup",
        operationId: "hung-operation",
        operationKind: "work-share-import",
      }),
    );
  });
});

function idleJobs() {
  return {
    current: null,
    clearIfCurrent: vi.fn(),
    runCleanup: vi.fn(async () => undefined),
  };
}
