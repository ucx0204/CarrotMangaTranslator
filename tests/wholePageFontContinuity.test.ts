import { describe, expect, it, vi } from "vitest";
import { candidateOrderSha256 } from "../src/main/pipeline/autoMatchActiveCatalogContract";
import {
  buildFontContinuityMetadata,
  hydrateFontContinuityBeforePage,
} from "../src/main/pipeline/wholePageFontContinuity";
import type { AutomaticFontPageCoordinatorV2 } from "../src/main/pipeline/automaticFontMatchingV2PageCoordinator";
import type { PipelineDiagnostics } from "../src/main/pipeline/translationAttemptLogging";
import {
  FONT_CONTINUITY_RUNTIME_CONTRACT,
  FONT_CONTINUITY_SCHEMA_VERSION,
  type FontContinuityObservation,
} from "../src/shared/translationCheckpoint";
import { makeAutomaticFontCandidate } from "./helpers/automaticFontCandidate";
import { makePage } from "./helpers/wholePagePipelineHarness";

describe("whole-page font continuity", () => {
  it("builds persistence metadata only when observations exist", () => {
    const observation = makeObservation("page-a", "font-a", "catalog-a");

    expect(buildFontContinuityMetadata([])).toBeUndefined();
    expect(buildFontContinuityMetadata([observation])).toMatchObject({
      schemaVersion: FONT_CONTINUITY_SCHEMA_VERSION,
      runtimeContractVersion: FONT_CONTINUITY_RUNTIME_CONTRACT,
      observations: [observation],
      savedAt: expect.any(String),
    });
  });

  it("hydrates verified predecessor observations before the selected page", async () => {
    const candidate = makeAutomaticFontCandidate({ fontId: "font-a" });
    const observation = makeObservation(
      "page-a",
      candidate.fontId,
      candidateOrderSha256([candidate.fontId]),
    );
    const predecessor = makePage("page-a", "001.png", {
      analysisStatus: "completed",
      fontContinuity: {
        schemaVersion: FONT_CONTINUITY_SCHEMA_VERSION,
        runtimeContractVersion: FONT_CONTINUITY_RUNTIME_CONTRACT,
        observations: [observation],
        savedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const selected = makePage("page-b", "002.png");
    const hydrateContinuity = vi.fn();
    const inferPage = vi.fn();

    const cursor = await hydrateFontContinuityBeforePage({
      beforePageId: selected.id,
      startIndex: 0,
      pages: [predecessor, selected],
      selectedPageIds: new Set([selected.id]),
      candidates: [candidate],
      coordinator: makeCoordinator(hydrateContinuity),
      pageInference: { inferPage },
      signal: new AbortController().signal,
      dependencies: makeDependencies(),
      targetLanguage: "ko",
    });

    expect(cursor).toBe(2);
    expect(hydrateContinuity).toHaveBeenCalledOnce();
    expect(hydrateContinuity).toHaveBeenCalledWith([observation]);
    expect(inferPage).not.toHaveBeenCalled();
  });

  it("falls back to read-only inference when stored continuity is unavailable", async () => {
    const candidate = makeAutomaticFontCandidate({ fontId: "font-a" });
    const predecessor = makePage("page-a", "001.png", {
      analysisStatus: "completed",
      blocks: [
        {
          id: "block-a",
          type: "nonsolid",
          bbox: { x: 10, y: 10, w: 100, h: 80 },
          sourceText: "こんにちは",
          translatedText: "안녕하세요",
          confidence: 1,
          sourceDirection: "horizontal",
          renderDirection: "horizontal",
          fontSizePx: 24,
          lineHeight: 1.2,
          textAlign: "center",
          textColor: "#111111",
          backgroundColor: "#ffffff",
          opacity: 1,
        },
      ],
    });
    const selected = makePage("page-b", "002.png");
    const hydrateContinuity = vi.fn();
    const inferPage = vi.fn(async () => ({
      pixelInferenceByBlockId: new Map(),
    }));

    await hydrateFontContinuityBeforePage({
      beforePageId: selected.id,
      startIndex: 0,
      pages: [predecessor, selected],
      selectedPageIds: new Set([selected.id]),
      candidates: [candidate],
      coordinator: makeCoordinator(hydrateContinuity),
      pageInference: { inferPage },
      signal: new AbortController().signal,
      dependencies: makeDependencies(),
      targetLanguage: "ko",
    });

    expect(inferPage).toHaveBeenCalledOnce();
    expect(inferPage).toHaveBeenCalledWith(
      expect.objectContaining({ page: predecessor, targetLanguage: "ko" }),
    );
    expect(hydrateContinuity).toHaveBeenCalledWith([]);
    expect(predecessor.fontContinuity).toBeUndefined();
  });
});

function makeCoordinator(
  hydrateContinuity: (
    observations: readonly FontContinuityObservation[],
  ) => void,
): AutomaticFontPageCoordinatorV2 {
  return {
    prepareWorkState: vi.fn(),
    recordDecision: vi.fn(),
    hydrateContinuity,
    snapshotPageContinuity: vi.fn(() => []),
  };
}

function makeDependencies(): { diagnostics: PipelineDiagnostics } {
  return {
    diagnostics: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

function makeObservation(
  pageId: string,
  selectedFontId: string,
  catalogHash: string,
): FontContinuityObservation {
  return {
    pageId,
    blockId: "block-a",
    role: "dialogue",
    selectedFontId,
    confidence: 0.94,
    orientation: "horizontal",
    sourceStyle: {
      serifness: 0.2,
      weight: 0.5,
      width: 0.5,
      roundness: 0.4,
      strokeContrast: 0.3,
      handwritten: 0.1,
      angularity: 0.2,
      irregularity: 0.1,
      slant: 0,
      energy: 0.3,
      unknownFields: [],
    },
    modelVersion: "test-runtime-v1",
    candidateOrderSha256: catalogHash,
  };
}
