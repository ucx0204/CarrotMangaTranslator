import { describe, expect, it } from "vitest";
import {
  canCompleteTranslationWorkflowWithoutTargets,
  countIncompleteInpaintingTargets,
  resolvePreviouslyErasedBlockIds,
} from "../src/main/jobs/inpaintingJobPageCompletion";
import type {
  InpaintingJobState,
  InpaintingTarget,
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

describe("inpainting job page completion", () => {
  it("does not trust partial erased ids without their saved artifact", () => {
    const page = makePage();
    page.translationCompletion = {
      workflow: "erase-original",
      status: "pending",
      erasedBlockIds: [page.blocks[0]?.id ?? "missing"],
    };

    expect(
      resolvePreviouslyErasedBlockIds(page, STATE, TARGET),
    ).toBeUndefined();
  });

  it("treats a matching completed artifact as a no-op full-page target", () => {
    const page = makePage();
    page.inpaintedImagePath = `${page.imagePath}.done.png`;
    page.translationCompletion = {
      workflow: "erase-original",
      status: "completed",
    };

    expect(resolvePreviouslyErasedBlockIds(page, STATE, TARGET)).toEqual([
      page.blocks[0]?.id,
    ]);
    expect(
      canCompleteTranslationWorkflowWithoutTargets(page, STATE, TARGET),
    ).toBe(true);
  });

  it("uses incomplete ids when a producer omits the redundant count", () => {
    expect(
      countIncompleteInpaintingTargets({
        blocksIncomplete: 0,
        incompleteBlockIds: ["block-1", "block-2"],
      }),
    ).toBe(2);
  });
});

function makePage(): MangaPage {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "page.png",
    imagePath: "C:\\library\\page.png",
    dataUrl: "data:image/png;base64,AA==",
    width: 100,
    height: 100,
    blocks: [
      {
        id: "block-1",
        type: "nonsolid",
        bbox: { x: 0, y: 0, w: 100, h: 100 },
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
      },
    ],
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
