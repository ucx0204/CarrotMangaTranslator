import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import {
  createPageProcessingTimingCollector,
  measurePageProcessingStage,
  measureSharedProcessingStage,
} from "../src/main/pipeline/pageProcessingTiming";
import {
  normalizePageProcessingTiming,
  sumPageProcessingTimingStages,
} from "../src/shared/pageProcessingTiming";

describe("page processing timing collector", () => {
  it("distributes shared milliseconds exactly and replaces translation timing", () => {
    const collector = createPageProcessingTimingCollector("translation-1", [
      "a",
      "b",
      "c",
    ]);
    collector.addShared("preparing", 1_001);
    collector.add("a", "translation", 2_000);

    const pages = ["a", "b", "c"].map((id) =>
      collector.applyTranslationTiming(page(id)),
    );
    expect(
      pages.map((item) => item.processingTiming?.stages.preparing),
    ).toEqual([334, 334, 333]);
    expect(
      pages.reduce(
        (total, item) =>
          total +
          Object.values(item.processingTiming?.stages ?? {}).reduce(
            (sum, value) => sum + value,
            0,
          ),
        0,
      ),
    ).toBe(3_001);
    expect(pages[0].processingTiming?.translationJobId).toBe("translation-1");
  });

  it("merges inpainting stages into the translated page record", () => {
    const translation = createPageProcessingTimingCollector("translation-1", [
      "a",
    ]);
    translation.add("a", "ocr", 500);
    const translated = translation.applyTranslationTiming(page("a"));
    const inpainting = createPageProcessingTimingCollector("inpainting-1", [
      "a",
    ]);
    inpainting.add("a", "inpainting", 1_500);
    inpainting.add("a", "typography", 250);

    const completed = inpainting.applyInpaintingTiming(translated);
    expect(completed.processingTiming).toMatchObject({
      translationJobId: "translation-1",
      inpaintingJobId: "inpainting-1",
      stages: { ocr: 500, inpainting: 1_500, typography: 250 },
    });
  });

  it("checkpoints the active stage from finally when it fails", async () => {
    const checkpoints: number[] = [];
    const collector = createPageProcessingTimingCollector("job-1", ["a"], {
      managed: true,
      sessionId: "session-1",
      onCheckpoint: async (updates) => {
        checkpoints.push(updates[0]?.timing.stages.translation ?? 0);
      },
    });
    const clock = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(225);

    await expect(
      measurePageProcessingStage(collector, "a", "translation", async () => {
        throw new Error("retry exhausted");
      }),
    ).rejects.toThrow("retry exhausted");

    expect(checkpoints).toEqual([125]);
    clock.mockRestore();
  });

  it("checkpoints shared model-load time when cancellation aborts it", async () => {
    const checkpoints: number[] = [];
    const collector = createPageProcessingTimingCollector("job-1", ["a"], {
      managed: true,
      sessionId: "session-1",
      onCheckpoint: async (updates) => {
        checkpoints.push(updates[0]?.timing.stages.preparing ?? 0);
      },
    });
    const clock = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_750);

    await expect(
      measureSharedProcessingStage(collector, "preparing", async () => {
        throw new DOMException("cancelled", "AbortError");
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(checkpoints).toEqual([750]);
    clock.mockRestore();
  });

  it("exposes managed checkpoint state while sanitizing collector edge values", async () => {
    const beforeCheckpoint = vi.fn();
    const checkpoints: unknown[] = [];
    const collector = createPageProcessingTimingCollector(
      "translation-1",
      ["a", "a", "b"],
      {
        managed: true,
        sessionId: "session-1",
        initialCheckpoint: 2.9,
        initialStagesByPageId: new Map([
          ["a", { preparing: 100.4, ocr: Number.NaN }],
          ["b", { preparing: -1 }],
        ]),
        translationJobId: "translation-original",
        onBeforeCheckpoint: beforeCheckpoint,
        onCheckpoint: async (updates) => {
          checkpoints.push(updates);
        },
      },
    );

    collector.add("missing", "ocr", 10);
    collector.add("a", "ocr", -1);
    collector.add("a", "ocr", Number.POSITIVE_INFINITY);
    collector.addShared("ocr", 1);
    collector.setStage("missing", "translation", 10);
    collector.setStage("a", "translation", 250.6);
    collector.setStage("a", "translation", 0);
    collector.setStage("a", "translation", 251.2);
    collector.setState("interrupted");
    collector.setTranslationJobId("translation-final");
    collector.setInpaintingJobId("inpainting-1");

    expect(collector.getPageIds()).toEqual(["a", "b"]);
    expect(collector.getStages("a")).toEqual({
      preparing: 100,
      ocr: 1,
      translation: 251,
    });
    expect(collector.getTotalMilliseconds()).toBe(352);
    await collector.checkpoint();

    expect(beforeCheckpoint).toHaveBeenCalledOnce();
    expect(checkpoints).toEqual([
      [
        expect.objectContaining({
          pageId: "a",
          timing: expect.objectContaining({
            checkpoint: 3,
            inpaintingJobId: "inpainting-1",
            sessionId: "session-1",
            state: "interrupted",
            translationJobId: "translation-final",
          }),
        }),
        expect.objectContaining({ pageId: "b" }),
      ],
    ]);
    expect(
      collector.applyTranslationTiming(page("a")).processingTiming,
    ).toMatchObject({ checkpoint: 3, state: "interrupted" });
    expect(
      collector.applyInpaintingTiming(page("a")).processingTiming,
    ).toMatchObject({ checkpoint: 3, state: "interrupted" });

    const empty = createPageProcessingTimingCollector("empty", [], {
      initialCheckpoint: Number.NaN,
      onBeforeCheckpoint: beforeCheckpoint,
    });
    empty.addShared("preparing", 100);
    await empty.checkpoint();
    expect(empty.getTotalMilliseconds()).toBe(0);
  });

  it("normalizes v1 and v2 timing values without losing their accounting", () => {
    expect(normalizePageProcessingTiming(undefined)).toEqual({
      stages: {},
      state: "interrupted",
      checkpoint: 0,
    });
    expect(
      normalizePageProcessingTiming({
        version: 2,
        sessionId: "session-1",
        state: "running",
        checkpoint: 3.9,
        measuredAt: "2026-01-01T00:00:00.000Z",
        stages: { preparing: 10.6, ocr: -1, translation: Number.NaN },
      }),
    ).toEqual({
      stages: { preparing: 11 },
      state: "running",
      sessionId: "session-1",
      checkpoint: 3,
    });
    expect(
      normalizePageProcessingTiming({
        version: 2,
        sessionId: "session-2",
        state: "interrupted",
        checkpoint: Number.NaN,
        measuredAt: "2026-01-01T00:00:00.000Z",
        stages: {},
      }).checkpoint,
    ).toBe(0);
    expect(
      normalizePageProcessingTiming({
        version: 1,
        measuredAt: "2026-01-01T00:00:00.000Z",
        stages: {
          preparing: 0,
          ocr: 1.4,
          translation: 100,
          postprocessing: 25.6,
          typography: -10,
          bubbleLayout: 10.2,
          inpainting: Number.POSITIVE_INFINITY,
        },
      }),
    ).toEqual({
      stages: { ocr: 1, translation: 126, typography: 10 },
      state: "completed",
      checkpoint: 0,
    });
    expect(
      sumPageProcessingTimingStages({
        preparing: 1.4,
        ocr: Number.NaN,
        translation: -3,
      }),
    ).toBe(1);
  });
});

function page(id: string): MangaPage {
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
  };
}
