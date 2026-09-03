import { describe, expect, it } from "vitest";
import type { TranslationOptions } from "../src/main/appSettings";
import { buildPreparedTranslationCheckpoint } from "../src/main/pipeline/preparedTranslationCheckpoint";
import { parsePageResponse } from "../src/main/pipeline/pageResponseParser";
import type { TranslationRuntimePort } from "../src/main/pipeline/translationRuntimePort";
import type { MangaPage } from "../src/shared/libraryTypes";
import { createPageRevision } from "../src/shared/pageRevision";

const overlayTools = require("../src/main/runtime/overlay-parser.cjs") as Pick<
  TranslationRuntimePort,
  | "normalizeItems"
  | "normalizeRegionSingleItem"
  | "parseJsonLenient"
  | "parseRegionSingleItem"
>;

describe("fixed-block fallback review projection", () => {
  it("marks only the degraded fixed block as needing review", () => {
    const items = [
      overlayItem(1, [1], "왼쪽"),
      overlayItem(2, [2], "오른쪽에 爪紅"),
    ];
    const parsed = parsePageResponse({
      runtime: overlayTools as TranslationRuntimePort,
      result: {
        outputText: JSON.stringify({ items }),
        rawResponse: {},
        requestBody: {
          fixedBlockIds: ["B001", "B002"],
          fixedBlockCandidateIds: [[1], [2]],
          fixedBlockNeedsReviewIds: ["B002"],
        },
      },
      page: makePage(),
      pageOptions: {} as TranslationOptions,
    });

    expect(parsed.items[0]?.reviewStatus).toBeUndefined();
    expect(parsed.items[1]?.reviewStatus).toBe("needs_review");

    const page = makePage();
    const checkpoint = buildPreparedTranslationCheckpoint({
      prepared: {
        kind: "translated",
        jobId: "job-1",
        page,
        pageOptions: {} as TranslationOptions,
        items: parsed.items,
        fontInferenceItems: parsed.items,
        soundDroppedCount: 0,
        validationDroppedCount: 0,
        validationReasons: {},
        contextWarnings: [],
      },
      pageId: page.id,
      inputRevision: createPageRevision(page),
      sourceLanguage: "ja",
      targetLanguage: "ko",
      blockMode: "auto",
      translationDurationMs: 1,
    });

    expect(checkpoint.prepared).toMatchObject({
      kind: "translated",
      items: [{}, { reviewStatus: "needs_review" }],
      fontInferenceItems: [{}, { reviewStatus: "needs_review" }],
    });
  });

  it("leaves translations unmarked when fallback provenance is incomplete", () => {
    const item = overlayItem(1, [1], "번역문");
    for (const requestBody of [
      undefined,
      "invalid-summary",
      { fixedBlockNeedsReviewIds: ["B001"] },
      {
        fixedBlockIds: ["B001"],
        fixedBlockNeedsReviewIds: ["B001"],
      },
    ]) {
      const parsed = parsePageResponse({
        runtime: overlayTools as TranslationRuntimePort,
        result: {
          outputText: JSON.stringify({ items: [item] }),
          rawResponse: {},
          requestBody,
        },
        page: makePage(),
        pageOptions: {} as TranslationOptions,
      });

      expect(parsed.items[0]?.reviewStatus).toBeUndefined();
    }
  });
});

function overlayItem(id: number, candidateIds: number[], ko: string) {
  return {
    id,
    candidateIds,
    type: "nonsolid",
    textRole: "ordinary",
    x1: id * 100,
    y1: 100,
    x2: id * 100 + 50,
    y2: 250,
    jp: id === 1 ? "左" : "右",
    ko,
    direction: "vertical",
    confidence: 1,
  };
}

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "001.jpg",
    imagePath: "001.jpg",
    dataUrl: "",
    width: 1000,
    height: 1500,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
