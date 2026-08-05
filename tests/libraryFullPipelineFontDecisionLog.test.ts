import { describe, expect, it } from "vitest";
import * as outlinePolicy from "../src/shared/textOutline";

type FontDecisionLogModule = {
  buildFontDecisionLog: (
    page: { blocks: unknown[] },
    trace: unknown,
    policy: typeof outlinePolicy,
  ) => Array<Record<string, unknown>>;
};

const { buildFontDecisionLog } =
  require("../scripts/library-full-pipeline-qa/font-decision-log.cjs") as FontDecisionLogModule;

describe("library font QA effective outline log", () => {
  it("records and validates the effective automatic outline", () => {
    const [decision] = buildFontDecisionLog(
      {
        blocks: [
          {
            id: "block-1",
            bbox: { x: 0, y: 0, w: 100, h: 50 },
            sourceText: "白",
            translatedText: "흰색",
            fontFamily: "dohyeon",
            textColor: "#f7f7f2",
            outlineColor: "#f7f7f2",
            outlineWidthScale: 0,
            automaticFontMatch: {
              selectedFontId: "dohyeon",
              role: "dialogue",
              confidence: 0.9,
              source: "local_visual",
            },
          },
        ],
      },
      { pixelInference: [] },
      outlinePolicy,
    );

    expect(decision).toMatchObject({
      applied: true,
      effectiveFontFamily: "dohyeon",
      effectiveOutlineWidthScale: 0,
      effectiveTextColor: "#f7f7f2",
      effectiveOutlineColor: "#111111",
    });
    expect(decision?.effectiveOutlineContrastRatio).toBeGreaterThanOrEqual(3);
  });

  it("does not reject an intentionally outline-free manual block", () => {
    const [decision] = buildFontDecisionLog(
      {
        blocks: [
          {
            id: "manual-block",
            bbox: { x: 0, y: 0, w: 100, h: 50 },
            sourceText: "手動",
            translatedText: "수동",
            textColor: "#111111",
            outlineWidthScale: 0,
          },
        ],
      },
      null,
      outlinePolicy,
    );

    expect(decision).toMatchObject({
      applied: false,
      effectiveOutlineWidthScale: 0,
    });
  });
});
