import { describe, expect, it } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import { createPageProcessingTimingCollector } from "../src/main/pipeline/pageProcessingTiming";

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
    inpainting.add("a", "bubbleLayout", 250);

    const completed = inpainting.applyInpaintingTiming(translated);
    expect(completed.processingTiming).toMatchObject({
      translationJobId: "translation-1",
      inpaintingJobId: "inpainting-1",
      stages: { ocr: 500, inpainting: 1_500, bubbleLayout: 250 },
    });
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
