import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn() },
}));

import { ActiveJobStore } from "../src/main/jobs/activeJob";
import { runWorkContextAnalysisJob } from "../src/main/ipc/workContextIpc";
import { WORK_CONTEXT_ANALYSIS_CANCELLED_ERROR } from "../src/shared/workContextAnalysisTypes";

describe("work-context analysis job", () => {
  it("registers an abortable active job and reports cancellation to the caller", async () => {
    const jobs = new ActiveJobStore();
    let receivedSignal: AbortSignal | undefined;
    const analyze = vi.fn((_request: unknown, signal: AbortSignal) => {
      receivedSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    });

    const running = runWorkContextAnalysisJob(
      { jobs, getMainWindow: () => null },
      { chapterId: "chapter-1", scope: "chapter" },
      analyze,
    );

    expect(jobs.current?.kind).toBe("gemma-analysis");
    jobs.current?.abortController.abort();

    await expect(running).rejects.toThrow(
      WORK_CONTEXT_ANALYSIS_CANCELLED_ERROR,
    );
    expect(receivedSignal?.aborted).toBe(true);
    expect(jobs.hasActive).toBe(false);
  });
});
