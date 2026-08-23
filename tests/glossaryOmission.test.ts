import { describe, expect, it } from "vitest";
import { applyGlossaryOmissionsToOverlayItems } from "../src/main/pipeline/glossaryOmission";
import type { OverlayItem } from "../src/main/pipeline/types";
import {
  applyGlossaryOmissionToTranslation,
  collectGlossaryOmissionTerms,
  omitGlossaryTermsFromSource,
} from "../src/shared/glossaryOmission";
import type { WorkStyleGuide } from "../src/shared/workContextTypes";

const ocrText = require("../src/main/runtime/prompts/ocr-text.cjs") as {
  sanitizeOcrTextForPrompt: (
    value: unknown,
    options?: Record<string, unknown>,
  ) => string;
};
const workContextPrompt =
  require("../src/main/runtime/prompts/work-context.cjs") as {
    buildWorkContextSection: (options?: Record<string, unknown>) => string[];
  };

describe("glossary omission rules", () => {
  it("collects only active blank translations and prefers the longest overlap", () => {
    expect(collectGlossaryOmissionTerms(makeGuide())).toEqual([
      "魔王様",
      "魔王",
      "。",
    ]);
    expect(
      omitGlossaryTermsFromSource("魔王様 と 魔王。", ["魔王", "魔王様", "。"]),
    ).toEqual({
      matchedTerms: ["魔王様", "魔王", "。"],
      text: "と",
    });
  });

  it("removes one equivalent target punctuation and empties a fully omitted block", () => {
    expect(
      applyGlossaryOmissionToTranslation({
        sourceText: "こんにちは。",
        translatedText: "안녕하세요.",
        terms: ["。"],
      }),
    ).toBe("안녕하세요");
    expect(
      applyGlossaryOmissionToTranslation({
        sourceText: "。",
        translatedText: ".",
        terms: ["。"],
      }),
    ).toBe("");
    expect(
      applyGlossaryOmissionToTranslation({
        sourceText: "こんにちは！",
        translatedText: "안녕하세요!",
        terms: ["。"],
      }),
    ).toBe("안녕하세요!");
  });

  it("uses original OCR membership for output cleanup without mutating source text", () => {
    const original = overlayItem({
      jp: "こんにちは",
      sourceText: "こんにちは",
      ko: "안녕하세요.",
      translatedText: "안녕하세요.",
    });
    const [cleaned] = applyGlossaryOmissionsToOverlayItems([original], {
      glossaryOmissionTerms: ["。"],
      ocrBboxResult: {
        hints: [{ id: 1, ocrText: "こんにちは。" }],
        diagnostics: [],
      },
    });

    expect(cleaned).toMatchObject({
      jp: "こんにちは。",
      sourceText: "こんにちは。",
      ko: "안녕하세요",
      translatedText: "안녕하세요",
    });
    expect(original.ko).toBe("안녕하세요.");
  });

  it("strips only the prompt copy of OCR text", () => {
    expect(
      ocrText.sanitizeOcrTextForPrompt("こんにちは。", {
        sourceLanguage: "ja",
        glossaryOmissionTerms: ["。"],
      }),
    ).toBe("こんにちは");
    expect(
      workContextPrompt.buildWorkContextSection({
        glossaryOmissionTerms: ["。"],
      }),
    ).toContain("- omit exactly: 。");
  });
});

function overlayItem(patch: Partial<OverlayItem> = {}): OverlayItem {
  return {
    id: 1,
    type: "nonsolid",
    bbox: { x: 0, y: 0, w: 100, h: 100 },
    jp: "こんにちは。",
    ko: "안녕하세요.",
    sourceText: "こんにちは。",
    translatedText: "안녕하세요.",
    ...patch,
  };
}

function makeGuide(): WorkStyleGuide {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    workId: "work-1",
    glossary: [
      glossary("long", "魔王", "", timestamp, ["魔王様"]),
      glossary("punctuation", "。", "   ", timestamp),
      glossary("translated", "勇者", "용사", timestamp),
      { ...glossary("disabled", "無効", "", timestamp), enabled: false },
    ],
    characters: [],
    rules: {
      honorifics: "adapt",
      sfxMode: "translate",
      defaultTone: "natural_korean",
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function glossary(
  id: string,
  source: string,
  target: string,
  timestamp: string,
  aliases: string[] = [],
) {
  return {
    id,
    source,
    target,
    category: "term" as const,
    aliases,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
