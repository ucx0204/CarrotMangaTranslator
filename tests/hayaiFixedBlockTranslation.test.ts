import { describe, expect, it } from "vitest";

const fixed =
  require("../src/main/runtime/semantic-ocr/fixed-block-translation.cjs") as {
    buildFixedBlockPlan: (
      options: Record<string, unknown>,
      variants: Array<Record<string, unknown>>,
    ) => {
      blocks: Array<{
        candidateIds: number[];
        ordinaryOnly?: boolean;
      }>;
    };
    buildFixedBlockOverlayPayload: (
      plan: Record<string, unknown>,
      translations: Record<string, unknown>,
    ) => { items: Array<{ textRole?: string }> };
  };

function hint(id: number, text: string, x1: number, x2: number) {
  return {
    id,
    label: "ocr_textline",
    x1,
    y1: 100,
    x2,
    y2: 340,
    score: 0.95,
    ocrText: text,
    groupId: "G001",
    orderInGroup: id,
    groupSize: 2,
    rolePrior: "ordinary_mergeable",
    containerType: "same_text_container",
    semanticGroup: true,
    geometryLocked: true,
  };
}

describe("Hayai fixed-block translation contract", () => {
  it("keeps every locked region as one immutable ordinary slot", () => {
    const plan = fixed.buildFixedBlockPlan(
      {
        ocrPipeline: "hayai",
        imageWidth: 1000,
        imageHeight: 1400,
        ocrBboxHints: [
          hint(1, "右の台詞", 500, 560),
          hint(2, "左の台詞", 570, 630),
        ],
      },
      [
        {
          role: "original",
          width: 1000,
          height: 1400,
          originalWidth: 1000,
          originalHeight: 1400,
        },
      ],
    );

    expect(plan.blocks.map(({ candidateIds }) => candidateIds)).toEqual([
      [1],
      [2],
    ]);
    expect(plan.blocks.every(({ ordinaryOnly }) => ordinaryOnly)).toBe(true);
    const overlay = fixed.buildFixedBlockOverlayPayload(plan, {
      items: [
        { blockId: "B001", textRole: "sound", ko: "오른쪽" },
        { blockId: "B002", textRole: "sound", ko: "왼쪽" },
      ],
    });
    expect(overlay.items.map(({ textRole }) => textRole)).toEqual([
      "ordinary",
      "ordinary",
    ]);
  });
});
