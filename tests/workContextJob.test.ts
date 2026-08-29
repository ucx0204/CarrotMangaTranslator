import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn() },
}));

import { ActiveJobStore } from "../src/main/jobs/activeJob";
import {
  runWorkContextAnalysisJob,
  runWorkContextResearchJob,
} from "../src/main/ipc/workContextIpc";
import { WORK_CONTEXT_ANALYSIS_CANCELLED_ERROR } from "../src/shared/workContextAnalysisTypes";
import { WORK_CONTEXT_RESEARCH_CANCELLED_ERROR } from "../src/shared/workContextResearchTypes";

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

  it("cancels an internet research preview without producing a proposal", async () => {
    const jobs = new ActiveJobStore();
    const research = vi.fn(
      (_request: unknown, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const running = runWorkContextResearchJob(
      { jobs, getMainWindow: () => null },
      {
        runId: "4fbccf35-fc79-47d0-ae2d-a80935155a5a",
        chapterId: "chapter-1",
        researchTitle: "테스트 작품",
        engine: "tavily",
        guideSnapshot: {
          schemaVersion: 1,
          workId: "work-1",
          glossary: [],
          characters: [],
          rules: {
            honorifics: "preserve",
            sfxMode: "translate",
            defaultTone: "natural_korean",
          },
          createdAt: "2026-08-28T00:00:00.000Z",
          updatedAt: "2026-08-28T00:00:00.000Z",
        },
      },
      research,
    );
    expect(jobs.current?.kind).toBe("internet-research");
    jobs.current?.abortController.abort();
    await expect(running).rejects.toThrow(
      WORK_CONTEXT_RESEARCH_CANCELLED_ERROR,
    );
    expect(jobs.hasActive).toBe(false);
  });

  it("returns a completed internet research proposal and clears the job", async () => {
    const jobs = new ActiveJobStore();
    const proposal = makeResearchProposal();
    const research = vi.fn(async () => proposal);

    await expect(
      runWorkContextResearchJob(
        { jobs, getMainWindow: () => null },
        makeResearchRequest(),
        research,
      ),
    ).resolves.toBe(proposal);
    expect(research).toHaveBeenCalledWith(
      makeResearchRequest(),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(jobs.hasActive).toBe(false);
  });

  it("reports an internet research failure and clears the job", async () => {
    const jobs = new ActiveJobStore();
    const research = vi.fn(async () => {
      throw new Error("research failed");
    });

    await expect(
      runWorkContextResearchJob(
        { jobs, getMainWindow: () => null },
        makeResearchRequest(),
        research,
      ),
    ).rejects.toThrow("research failed");
    expect(jobs.hasActive).toBe(false);
  });

  it("normalizes a non-Error internet research rejection", async () => {
    const jobs = new ActiveJobStore();
    const research = vi.fn(() => Promise.reject("research rejected"));

    await expect(
      runWorkContextResearchJob(
        { jobs, getMainWindow: () => null },
        makeResearchRequest(),
        research,
      ),
    ).rejects.toBe("research rejected");
    expect(jobs.hasActive).toBe(false);
  });

  it("does not start internet research while another job is active", async () => {
    const jobs = new ActiveJobStore();
    jobs.start({
      id: "already-running",
      kind: "internet-research",
      abortController: new AbortController(),
    });

    await expect(
      runWorkContextResearchJob(
        { jobs, getMainWindow: () => null },
        makeResearchRequest(),
        vi.fn(async () => makeResearchProposal()),
      ),
    ).rejects.toThrow();
  });
});

function makeResearchRequest() {
  return {
    runId: "4fbccf35-fc79-47d0-ae2d-a80935155a5a",
    chapterId: "chapter-1",
    researchTitle: "테스트 작품",
    engine: "tavily" as const,
    guideSnapshot: {
      schemaVersion: 1 as const,
      workId: "work-1",
      glossary: [],
      characters: [],
      rules: {
        honorifics: "preserve" as const,
        sfxMode: "translate" as const,
        defaultTone: "natural_korean" as const,
      },
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    },
  };
}

function makeResearchProposal() {
  return {
    engine: "codex-web" as const,
    baseFingerprint: "fingerprint",
    operations: [],
    warnings: [],
    stats: {
      queryCount: 1,
      sourceCount: 1,
      tavilyCreditsUsed: 0,
      estimatedTokenDelta: 0,
      elapsedMs: 1,
    },
  };
}
