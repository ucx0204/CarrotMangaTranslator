import { describe, expect, it, vi } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { PageProcessingTimingV2 } from "../src/shared/pageProcessingTiming";
import {
  createPageTimingSessionManager,
  type PageTimingSessionManagerDependencies,
} from "../src/main/jobs/pageTimingSessionManager";
import { canApplyPageTimingUpdate } from "../src/main/libraryStore/libraryTimingMutations";

const SESSION_A = "00000000-0000-4000-8000-000000000001";
const SESSION_B = "00000000-0000-4000-8000-000000000002";

describe("page timing session manager", () => {
  it("reconciles a 17-minute 40-second wall-clock run exactly", async () => {
    const harness = createHarness();
    const pages = [page("a"), page("b")];
    harness.now.value = 2_000;
    const collector = await harness.manager.open({
      chapterId: "chapter-a",
      getMainWindow: () => null,
      jobId: "translation-job",
      kind: "translation",
      pages,
      session: { id: SESSION_A, startedAtEpochMs: 0 },
    });

    collector.addShared("ocr", 40_000);
    harness.now.value = 42_000;
    await collector.checkpoint();
    collector.add("a", "translation", 300_000);
    collector.add("b", "translation", 400_000);
    harness.now.value = 742_000;
    await collector.checkpoint();

    const result = await harness.manager.finish({
      chapterId: "chapter-a",
      sessionId: SESSION_A,
      elapsedMs: 1_060_000,
      state: "completed",
    });

    expect(result.updated).toBe(true);
    const final = latestByPage(harness.writes);
    expect(sumTimings(final)).toBe(1_060_000);
    expect(
      [...final.values()].every((timing) => timing.state === "completed"),
    ).toBe(true);
  });

  it("accumulates interrupted runs and resets completed retranslations", async () => {
    const interrupted = page(
      "resume",
      timing(SESSION_A, "interrupted", {
        preparing: 1_000,
        translation: 5_000,
      }),
    );
    const completed = page(
      "reset",
      timing(SESSION_A, "completed", {
        preparing: 1_000,
        translation: 5_000,
      }),
    );

    const resumedHarness = createHarness();
    resumedHarness.now.value = 12_000;
    await resumedHarness.manager.open({
      chapterId: "chapter-a",
      getMainWindow: () => null,
      jobId: "resume-job",
      kind: "translation",
      pages: [interrupted],
      session: { id: SESSION_B, startedAtEpochMs: 10_000 },
    });
    await resumedHarness.manager.finish({
      chapterId: "chapter-a",
      sessionId: SESSION_B,
      elapsedMs: 3_000,
      state: "completed",
    });
    expect(sumTimings(latestByPage(resumedHarness.writes))).toBe(9_000);

    const resetHarness = createHarness();
    resetHarness.now.value = 12_000;
    await resetHarness.manager.open({
      chapterId: "chapter-a",
      getMainWindow: () => null,
      jobId: "reset-job",
      kind: "translation",
      pages: [completed],
      session: { id: SESSION_B, startedAtEpochMs: 10_000 },
    });
    await resetHarness.manager.finish({
      chapterId: "chapter-a",
      sessionId: SESSION_B,
      elapsedMs: 3_000,
      state: "completed",
    });
    expect(sumTimings(latestByPage(resetHarness.writes))).toBe(3_000);
  });

  it("retains translation timing when standalone inpainting starts", async () => {
    const harness = createHarness();
    harness.now.value = 11_000;
    const collector = await harness.manager.open({
      chapterId: "chapter-a",
      getMainWindow: () => null,
      jobId: "inpainting-job",
      kind: "inpainting",
      pages: [
        page("a", timing(SESSION_A, "completed", { translation: 4_000 })),
      ],
      session: { id: SESSION_B, startedAtEpochMs: 10_000 },
    });
    collector.add("a", "inpainting", 2_000);
    await harness.manager.finish({
      chapterId: "chapter-a",
      sessionId: SESSION_B,
      elapsedMs: 3_000,
      state: "completed",
    });

    const final = latestByPage(harness.writes).get("a");
    expect(final?.stages.translation).toBe(4_000);
    expect(final?.stages.inpainting).toBe(2_000);
    expect(sumTiming(final)).toBe(7_000);
  });

  it("attributes endpoint startup delay to setup and model load", async () => {
    const harness = createHarness();
    harness.now.value = 8_000;
    await harness.manager.open({
      chapterId: "chapter-a",
      getMainWindow: () => null,
      jobId: "translation-job",
      kind: "translation",
      pages: [page("a")],
      session: { id: SESSION_A, startedAtEpochMs: 1_000 },
    });

    expect(latestByPage(harness.writes).get("a")?.stages.preparing).toBe(7_000);
  });

  it("keeps one session through translation, transition, and interrupted inpainting", async () => {
    const harness = createHarness();
    const sourcePage = page("a");
    const collector = await harness.manager.open({
      chapterId: "chapter-a",
      getMainWindow: () => null,
      jobId: "translation-job",
      kind: "translation",
      pages: [sourcePage],
      session: { id: SESSION_A, startedAtEpochMs: 0 },
    });
    collector.add("a", "translation", 1_000);
    harness.now.value = 1_000;
    await collector.checkpoint();
    harness.now.value = 1_400;
    const continued = await harness.manager.open({
      chapterId: "chapter-a",
      getMainWindow: () => null,
      jobId: "inpainting-job",
      kind: "inpainting",
      pages: [sourcePage],
      session: { id: SESSION_A, startedAtEpochMs: 0 },
    });
    continued.add("a", "inpainting", 500);
    await harness.manager.finish({
      chapterId: "chapter-a",
      sessionId: SESSION_A,
      elapsedMs: 2_000,
      state: "interrupted",
    });

    const final = latestByPage(harness.writes).get("a");
    expect(final).toMatchObject({
      sessionId: SESSION_A,
      state: "interrupted",
      translationJobId: "translation-job",
      inpaintingJobId: "inpainting-job",
    });
    expect(sumTiming(final)).toBe(2_000);
  });

  it("does not let a late checkpoint replace a newer session", () => {
    const current = timing(SESSION_B, "running", { preparing: 10 });
    expect(
      canApplyPageTimingUpdate(current, {
        pageId: "a",
        timing: timing(SESSION_A, "running", { preparing: 20 }),
        startSession: true,
        replacesSessionId: "00000000-0000-4000-8000-000000000099",
      }),
    ).toBe(false);
    expect(
      canApplyPageTimingUpdate(current, {
        pageId: "a",
        timing: timing(SESSION_A, "running", { preparing: 20 }),
      }),
    ).toBe(false);
  });

  it("logs timing persistence failures without rejecting the measured work", async () => {
    const harness = createHarness(true);
    harness.now.value = 1_000;
    const collector = await harness.manager.open({
      chapterId: "chapter-a",
      getMainWindow: () => null,
      jobId: "translation-job",
      kind: "translation",
      pages: [page("a")],
      session: { id: SESSION_A, startedAtEpochMs: 0 },
    });
    collector.add("a", "ocr", 500);
    await expect(collector.checkpoint()).resolves.toBeUndefined();
    await expect(
      harness.manager.finish({
        chapterId: "chapter-a",
        sessionId: SESSION_A,
        elapsedMs: 2_000,
        state: "interrupted",
      }),
    ).resolves.toEqual({ updated: false });
    expect(harness.logError).toHaveBeenCalled();
  });
});

function createHarness(failPersistence = false) {
  const now = { value: 0 };
  const writes: Array<
    Array<{ pageId: string; timing: PageProcessingTimingV2 }>
  > = [];
  const logError = vi.fn();
  const dependencies: PageTimingSessionManagerDependencies = {
    nowEpochMs: () => now.value,
    persist: async (_chapterId, updates) => {
      if (failPersistence) throw new Error("disk full");
      writes.push(
        updates.map(({ pageId, timing: timingValue }) => ({
          pageId,
          timing: timingValue,
        })),
      );
      return new Set(updates.map((update) => update.pageId));
    },
    emitUpdated: vi.fn(),
    logError,
    logWarn: vi.fn(),
  };
  return {
    logError,
    manager: createPageTimingSessionManager(dependencies),
    now,
    writes,
  };
}

function latestByPage(
  writes: ReadonlyArray<
    ReadonlyArray<{ pageId: string; timing: PageProcessingTimingV2 }>
  >,
) {
  const latest = new Map<string, PageProcessingTimingV2>();
  for (const batch of writes) {
    for (const update of batch) {
      latest.set(update.pageId, update.timing);
    }
  }
  return latest;
}

function sumTimings(values: ReadonlyMap<string, PageProcessingTimingV2>) {
  return [...values.values()].reduce(
    (total, value) => total + sumTiming(value),
    0,
  );
}

function sumTiming(value: PageProcessingTimingV2 | undefined) {
  return Object.values(value?.stages ?? {}).reduce(
    (total, milliseconds) => total + milliseconds,
    0,
  );
}

function timing(
  sessionId: string,
  state: PageProcessingTimingV2["state"],
  stages: PageProcessingTimingV2["stages"],
): PageProcessingTimingV2 {
  return {
    version: 2,
    sessionId,
    state,
    checkpoint: 1,
    measuredAt: "2026-01-01T00:00:00.000Z",
    stages,
  };
}

function page(
  id: string,
  processingTiming?: PageProcessingTimingV2,
): MangaPage {
  return {
    id,
    name: `${id}.jpg`,
    imagePath: `${id}.jpg`,
    dataUrl: "",
    width: 100,
    height: 100,
    blocks: [],
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    processingTiming,
  };
}
