import { describe, expect, it } from "vitest";
import { shouldUseOriginalPatternImage } from "../src/main/inpainting/patternBlockEligibility";
import {
  completeTranslationWorkflow,
  resolvePreviouslyErasedBlockIds,
} from "../src/main/jobs/inpaintingJobPageCompletion";
import type {
  InpaintingJobState,
  InpaintingTarget,
  ProcessedInpaintingPageResult,
} from "../src/main/jobs/inpaintingJobPageTypes";
import type { MangaPage } from "../src/shared/libraryTypes";

const TARGET: InpaintingTarget = {
  drawnPatternMode: false,
  drawnStrokes: [],
  layoutOnly: false,
  targetType: "source",
};

const STATE = {
  requestedCompletionWorkflow: "erase-original",
} as InpaintingJobState;

describe("legacy translation completion reference safety", () => {
  it("uses the original image for a stale pending receipt", () => {
    const page = makePage();
    page.inpaintedImagePath = "partial.png";
    page.translationCompletion = {
      workflow: "erase-original",
      status: "pending",
      erasedBlockIds: ["legacy-a"],
    };

    expect(shouldUseOriginalPatternImage(page)).toBe(true);
  });

  it("keeps using the partial image for a valid pending receipt", () => {
    const page = makePage();
    page.inpaintedImagePath = "partial.png";
    page.translationCompletion = {
      workflow: "erase-original",
      status: "pending",
      erasedBlockIds: [blockId(page, 0)],
    };

    expect(shouldUseOriginalPatternImage(page)).toBe(false);
  });

  it("does not exclude any block for a stale pending receipt", () => {
    const page = makePage();
    page.inpaintedImagePath = "partial.png";
    page.translationCompletion = {
      workflow: "erase-original",
      status: "pending",
      erasedBlockIds: ["legacy-a"],
    };

    expect(
      resolvePreviouslyErasedBlockIds(page, STATE, TARGET),
    ).toBeUndefined();
  });

  it("returns current ids for a valid pending receipt", () => {
    const page = makePage();
    page.inpaintedImagePath = "partial.png";
    page.translationCompletion = {
      workflow: "erase-original",
      status: "pending",
      erasedBlockIds: [blockId(page, 0)],
    };

    expect(resolvePreviouslyErasedBlockIds(page, STATE, TARGET)).toEqual([
      blockId(page, 0),
    ]);
  });

  it("does not merge a stale id into the next saved completion", () => {
    const page = makePage();
    page.inpaintedImagePath = "partial.png";
    page.translationCompletion = {
      workflow: "erase-original",
      status: "pending",
      erasedBlockIds: ["legacy-a"],
    };
    const result: ProcessedInpaintingPageResult = {
      page,
      blocksErased: 1,
      blocksIncomplete: 1,
      erasedBlockIds: [blockId(page, 0)],
      incompleteBlockIds: [blockId(page, 1)],
    };

    expect(
      completeTranslationWorkflow(result, STATE, TARGET).page
        .translationCompletion,
    ).toEqual({
      workflow: "erase-original",
      status: "pending",
      erasedBlockIds: [blockId(page, 0)],
    });
  });

  it("keeps completed semantics while dropping stale receipt ids", () => {
    const page = makePage();
    page.inpaintedImagePath = "completed.png";
    page.translationCompletion = {
      workflow: "erase-original",
      status: "completed",
      erasedBlockIds: ["legacy-a"],
    };

    expect(resolvePreviouslyErasedBlockIds(page, STATE, TARGET)).toEqual(
      page.blocks.map((block) => block.id),
    );
  });
});

function blockId(page: MangaPage, index: number): string {
  const block = page.blocks[index];
  if (!block) throw new Error(`Expected block at index ${index}`);
  return block.id;
}

function makePage(): MangaPage {
  return {
    id: "page-a",
    name: "page.png",
    imagePath: "original.png",
    dataUrl: "data:image/png;base64,AA==",
    width: 100,
    height: 100,
    blocks: [makeBlock("current-a", 0), makeBlock("current-b", 50)],
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeBlock(id: string, x: number): MangaPage["blocks"][number] {
  return {
    id,
    type: "nonsolid",
    bbox: { x, y: 0, w: 40, h: 40 },
    sourceText: "source",
    translatedText: "translated",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 16,
    lineHeight: 1.2,
    textAlign: "left",
    textColor: "#000000",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}
