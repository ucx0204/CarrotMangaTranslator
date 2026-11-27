import { describe, expect, it } from "vitest";

const {
  createPromptOptions,
  shouldSkipModelRequest,
} = require("../src/main/runtime/transport/translation-ocr-policy.cjs");

const empty = {
  noTextDetected: true,
  hints: [],
  textEvidenceCount: 0,
  diagnostics: [],
};

function skips(
  result: {
    noTextDetected: boolean;
    hints: unknown[];
    textEvidenceCount: number;
  },
  options: Record<string, unknown>,
) {
  return shouldSkipModelRequest(result, createPromptOptions(options, result));
}

describe("whole-page OCR no-text handling", () => {
  it.each(["ja", "en", "zh-Hans", "auto"])(
    "applies confirmed empty OCR to %s dialogue and still collects visual context",
    (sourceLanguage) => {
      const options = { sourceLanguage, ocrQualityMode: "full" };
      expect(skips(empty, options)).toBe(true);
      expect(skips(empty, { ...options, collectPageContext: true })).toBe(
        false,
      );
      expect(skips({ ...empty, noTextDetected: false }, options)).toBe(false);
    },
  );

  it.each(["regionCropMode", "soundEffectTranslationMode", "keepBlocksMode"])(
    "preserves explicit %s targets",
    (mode) => {
      expect(
        skips(empty, {
          sourceLanguage: "ja",
          ocrQualityMode: "full",
          [mode]: true,
        }),
      ).toBe(false);
    },
  );

  it("preserves the Japanese semantic guard for unread geometry and lets other source languages inspect it", () => {
    const unread = {
      ...empty,
      noTextDetected: false,
      hints: [{ id: 1, label: "text" }],
    };
    expect(
      skips(unread, { sourceLanguage: "ja", ocrQualityMode: "full" }),
    ).toBe(true);
    for (const sourceLanguage of ["en", "zh-Hans", "auto"]) {
      expect(skips(unread, { sourceLanguage, ocrQualityMode: "full" })).toBe(
        false,
      );
    }
  });
});
