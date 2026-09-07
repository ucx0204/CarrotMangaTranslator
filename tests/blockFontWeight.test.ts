import { describe, expect, it } from "vitest";
import {
  resolveFontWeight,
  normalizeFontWeightPatch,
} from "../src/shared/blockFontWeight";
import { TranslationBlockObjectSchema } from "../src/shared/ipcSchemaPrimitives";
import { parseRichText } from "../src/shared/richTextMarkup";
import { normalizeTranslationBlockPatch } from "../src/renderer/src/hooks/useUpdateSelectedBlockAction";
import { measureStyledGraphemes } from "../src/renderer/src/lib/overlayTextWrapping";
import {
  buildBlockStylePresetFormat,
  normalizePresetFormat,
  resolveBlockStylePresetPatchFields,
} from "../src/shared/blockStylePresetFormat";
import type { TranslationBlock } from "../src/shared/textTypes";

const block: TranslationBlock = {
  id: "weight-fixture",
  type: "nonsolid",
  bbox: { x: 0, y: 0, w: 200, h: 200 },
  sourceText: "例",
  translatedText: "예시",
  confidence: 1,
  sourceDirection: "vertical",
  renderDirection: "horizontal",
  fontSizePx: 24,
  lineHeight: 1.18,
  textAlign: "center",
  textColor: "#111111",
  backgroundColor: "#ffffff",
  opacity: 1,
  fontFamily: "nanum-myeongjo",
  bold: true,
  fontWeight: 700,
};

describe("automatic font weight survives the block contract", () => {
  it.each([200, 300, 400, 500, 600, 700, 800, 900])(
    "round trips weight %i through IPC",
    (fontWeight) => {
      const input = { ...block, fontWeight, bold: fontWeight >= 600 };
      const restored = TranslationBlockObjectSchema.parse(
        JSON.parse(JSON.stringify(input)),
      );
      expect(resolveFontWeight(restored)).toBe(fontWeight);
    },
  );

  it("keeps legacy regular/bold and rejects malformed weights", () => {
    expect(resolveFontWeight({})).toBe(400);
    expect(resolveFontWeight({ bold: true })).toBe(800);
    for (const fontWeight of [0, 901, NaN, 300.5]) {
      expect(resolveFontWeight({ fontWeight })).toBe(400);
      expect(
        TranslationBlockObjectSchema.safeParse({ ...block, fontWeight })
          .success,
      ).toBe(false);
    }
  });

  it("manual bold changes cannot resurrect a previous automatic face", () => {
    const off = normalizeTranslationBlockPatch(block, { bold: false });
    const on = normalizeTranslationBlockPatch(off, { bold: true });
    expect(resolveFontWeight(off)).toBe(400);
    expect(resolveFontWeight(on)).toBe(800);
    expect(on.fontWeight).toBeUndefined();
    expect(
      normalizeTranslationBlockPatch(block, { textColor: "#ff0000" })
        .fontWeight,
    ).toBe(700);
    expect(
      normalizeTranslationBlockPatch(block, { fontFamily: "jua" }).fontWeight,
    ).toBeUndefined();
  });

  it("copies and persists exact weights with emphasis presets", () => {
    const format = normalizePresetFormat(
      buildBlockStylePresetFormat(block, ["emphasis"]),
      ["emphasis"],
    );
    const patch = resolveBlockStylePresetPatchFields(
      { groupIds: ["emphasis"], format },
      {},
    );
    expect(
      resolveFontWeight({ ...block, ...normalizeFontWeightPatch(patch) }),
    ).toBe(700);
  });

  it("uses the same weight for canvas measurements and rendered runs, including inline overrides", () => {
    const runs = parseRichText(
      "가 **나** [font=jua]다[/font]",
      false,
      false,
      300,
    ).runs;
    const measured: string[] = [];
    const context = {
      font: "",
      measureText() {
        measured.push(this.font);
        return { width: 12 } as TextMetrics;
      },
    };
    const graphemes = measureStyledGraphemes(context, runs, 24, "Fixture");
    expect(measured[0]).toBe("300 24px Fixture");
    expect(graphemes.find((g) => g.text === "가")?.fontWeight).toBe(300);
    expect(
      resolveFontWeight(graphemes.find((g) => g.text === "나") ?? {}),
    ).toBe(800);
    expect(
      resolveFontWeight(graphemes.find((g) => g.text === "다") ?? {}),
    ).toBe(400);
  });
});
