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
            outlineColor: "#111111",
            outlineWidthScale: 1,
            fontRole: "dialogue",
          },
        ],
      },
      {
        pixelInference: [
          {
            blockId: "block-1",
            selectionCalibration: { applied: true },
            localEvidence: { calibratedConfidence: 0.9 },
          },
        ],
      },
      outlinePolicy,
    );

    expect(decision).toMatchObject({
      applied: true,
      effectiveFontFamily: "dohyeon",
      effectiveOutlineWidthScale: 1,
      effectiveTextColor: "#f7f7f2",
      effectiveOutlineColor: "#111111",
    });
    expect(decision?.effectiveOutlineContrastRatio).toBeGreaterThanOrEqual(3);
  });

  it("rejects an automatic block whose required outline was removed", () => {
    expect(() =>
      buildFontDecisionLog(
        {
          blocks: [
            {
              id: "automatic-outline-free",
              bbox: { x: 0, y: 0, w: 100, h: 50 },
              sourceText: "白",
              translatedText: "흰색",
              fontFamily: "dohyeon",
              textColor: "#f7f7f2",
              outlineColor: "#111111",
              outlineWidthScale: 0,
              fontRole: "dialogue",
            },
          ],
        },
        {
          pixelInference: [
            {
              blockId: "automatic-outline-free",
              selectionCalibration: { applied: true },
              localEvidence: { calibratedConfidence: 0.9 },
            },
          ],
        },
        outlinePolicy,
      ),
    ).toThrow(
      "Applied automatic font removed the required text outline: automatic-outline-free",
    );
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
