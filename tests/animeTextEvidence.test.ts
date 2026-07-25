import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import type { TranslationOptions } from "../src/main/appSettings";
import type { OcrBboxResult } from "../src/main/pipeline/types";
import type { AnimeTextDetection } from "../src/main/textDetection/animeTextContracts";
import { buildAnimeTextRunnerArgs } from "../src/main/textDetection/animeTextAssets";
import {
  attachAnimeTextEvidence,
  createAnimeTextEvidencePort,
  shouldRunAnimeTextDetector,
} from "../src/main/textDetection/animeTextEvidence";

type AnimeTextRelationRuntime = {
  hasPotentialAnimeTextRelation: (hints: unknown[]) => boolean;
  qualifyAnimeTextRelationRegionIds: (hints: unknown[]) => string[];
};

const requireRuntime = createRequire(import.meta.url);
const relationRuntime = requireRuntime(
  "../src/main/runtime/semantic-ocr/anime-text-review-relations.cjs",
) as AnimeTextRelationRuntime;

const detection: AnimeTextDetection = {
  imageWidth: 500,
  imageHeight: 800,
  variant: "n",
  regions: [
    {
      labelId: 0,
      label: "text_block",
      score: 0.91,
      bbox: [90, 90, 220, 310],
    },
  ],
};

function options(
  overrides: Partial<TranslationOptions> = {},
): TranslationOptions {
  return {
    imagePath: "C:/pages/page.png",
    imageWidth: 500,
    imageHeight: 800,
    ocrDevice: "cpu",
    ...overrides,
  } as TranslationOptions;
}

function ambiguousResult(): OcrBboxResult {
  return {
    hints: [
      {
        id: 1,
        x1: 110,
        y1: 110,
        x2: 140,
        y2: 150,
        reviewFragmentId: "D001",
        reviewStatus: "deferred",
        reviewOrder: 1,
      },
      {
        id: 2,
        x1: 150,
        y1: 120,
        x2: 180,
        y2: 260,
        reviewFragmentId: "B001",
        reviewStatus: "confirmed",
        reviewOrder: 1,
        groupId: "G001",
        groupSize: 2,
        orderInGroup: 1,
      },
      {
        id: 3,
        x1: 180,
        y1: 120,
        x2: 210,
        y2: 280,
        reviewFragmentId: "B001",
        reviewStatus: "confirmed",
        reviewOrder: 2,
        groupId: "G001",
        groupSize: 2,
        orderInGroup: 2,
      },
    ],
    diagnostics: [],
    noTextDetected: false,
    textEvidenceCount: 3,
  };
}

describe("anime-text-yolo grouping evidence", () => {
  it("pins the detector to CPU independently of the translation GPU backend", () => {
    expect(
      buildAnimeTextRunnerArgs("C:/models/anime-text.safetensors"),
    ).toEqual([
      "--model",
      "anime-text-yolo",
      "--weights",
      "C:/models/anime-text.safetensors",
      "--backend",
      "cpu",
    ]);
  });

  it("does not initialize the model for an already unambiguous page", async () => {
    const result: OcrBboxResult = {
      hints: [
        {
          id: 1,
          x1: 10,
          y1: 10,
          x2: 30,
          y2: 50,
          reviewFragmentId: "B001",
          reviewStatus: "confirmed",
        },
      ],
      diagnostics: [],
    };
    const acquireDetector = vi.fn();
    const port = createAnimeTextEvidencePort({
      dataRoot: "C:/data",
      hasPotentialRelation: relationRuntime.hasPotentialAnimeTextRelation,
      qualifyRelationRegionIds:
        relationRuntime.qualifyAnimeTextRelationRegionIds,
      acquireDetector,
      reportWarning: vi.fn(),
    });

    const actual = await port.annotate(options(), result);

    expect(actual).toBe(result);
    expect(acquireDetector).not.toHaveBeenCalled();
    expect(
      shouldRunAnimeTextDetector(
        options(),
        result,
        relationRuntime.hasPotentialAnimeTextRelation,
      ),
    ).toBe(false);
  });

  it("does not run for confirmed-only review contexts that cannot consume YOLO evidence", async () => {
    const result: OcrBboxResult = {
      hints: [
        {
          id: 1,
          x1: 10,
          y1: 10,
          x2: 30,
          y2: 50,
          reviewFragmentId: "B001",
          reviewStatus: "confirmed",
          reviewContextId: "RC001",
        },
        {
          id: 2,
          x1: 32,
          y1: 10,
          x2: 52,
          y2: 50,
          reviewFragmentId: "B002",
          reviewStatus: "confirmed",
          reviewContextId: "RC001",
        },
      ],
      diagnostics: [],
    };
    const acquireDetector = vi.fn();
    const port = createAnimeTextEvidencePort({
      dataRoot: "C:/data",
      hasPotentialRelation: relationRuntime.hasPotentialAnimeTextRelation,
      qualifyRelationRegionIds:
        relationRuntime.qualifyAnimeTextRelationRegionIds,
      acquireDetector,
      reportWarning: vi.fn(),
    });

    expect(await port.annotate(options(), result)).toBe(result);
    expect(acquireDetector).not.toHaveBeenCalled();
    expect(
      shouldRunAnimeTextDetector(
        options(),
        result,
        relationRuntime.hasPotentialAnimeTextRelation,
      ),
    ).toBe(false);
  });

  it("skips deferred-only pages because there is no confirmed fragment to review against", () => {
    const result: OcrBboxResult = {
      hints: [
        {
          id: 1,
          x1: 10,
          y1: 10,
          x2: 30,
          y2: 50,
          reviewFragmentId: "D001",
          reviewStatus: "deferred",
        },
      ],
      diagnostics: [],
    };

    expect(
      shouldRunAnimeTextDetector(
        options(),
        result,
        relationRuntime.hasPotentialAnimeTextRelation,
      ),
    ).toBe(false);
  });

  it("does not start the detector when every deferred fragment is forbidden as a host", async () => {
    const result = ambiguousResult();
    result.hints[0] = {
      ...(result.hints[0] as Record<string, unknown>),
      reviewReasons: ["oversized_display_text"],
    };
    const acquireDetector = vi.fn();
    const port = createAnimeTextEvidencePort({
      dataRoot: "C:/data",
      hasPotentialRelation: relationRuntime.hasPotentialAnimeTextRelation,
      qualifyRelationRegionIds:
        relationRuntime.qualifyAnimeTextRelationRegionIds,
      acquireDetector,
      reportWarning: vi.fn(),
    });

    expect(await port.annotate(options(), result)).toBe(result);
    expect(acquireDetector).not.toHaveBeenCalled();
  });

  it("adds review-only evidence without changing existing grouping", () => {
    const result = ambiguousResult();

    const actual = attachAnimeTextEvidence(
      result,
      detection,
      relationRuntime.qualifyAnimeTextRelationRegionIds,
      {
        width: 500,
        height: 800,
      },
    );

    expect(actual).not.toBe(result);
    expect(actual.hints).toHaveLength(result.hints.length);
    expect(actual.hints).toEqual(
      result.hints.map((hint) =>
        expect.objectContaining({
          ...(hint as Record<string, unknown>),
          animeTextRegionId: "ATY001",
          animeTextEvidenceVersion: 1,
        }),
      ),
    );
    expect(
      actual.hints.map((hint) => (hint as { groupId?: string }).groupId),
    ).toEqual([undefined, "G001", "G001"]);
  });

  it("treats an empty or low-confidence detector result as an exact no-op", () => {
    const result = ambiguousResult();
    const empty: AnimeTextDetection = {
      ...detection,
      regions: [{ ...detection.regions[0], score: 0.44 }],
    };

    expect(
      attachAnimeTextEvidence(
        result,
        empty,
        relationRuntime.qualifyAnimeTextRelationRegionIds,
      ),
    ).toBe(result);
  });

  it("keeps exact identity when a detector region only matches a confirmed fragment", () => {
    const result = ambiguousResult();
    const confirmedOnly: AnimeTextDetection = {
      ...detection,
      regions: [
        {
          ...detection.regions[0],
          bbox: [145, 105, 220, 310],
        },
      ],
    };

    expect(
      attachAnimeTextEvidence(
        result,
        confirmedOnly,
        relationRuntime.qualifyAnimeTextRelationRegionIds,
      ),
    ).toBe(result);
  });

  it("removes stale evidence after a successful detector pass finds no qualified relation", () => {
    const result = ambiguousResult();
    result.hints = result.hints.map((hint) => ({
      ...(hint as Record<string, unknown>),
      animeTextRegionId: "ATY999",
      animeTextRegionScore: 0.99,
      animeTextContainment: 1,
      animeTextRegionBbox: [1, 1, 2, 2],
      animeTextEvidenceVersion: 1,
      animeTextModelRevision: "stale",
    }));
    const empty: AnimeTextDetection = {
      ...detection,
      regions: [],
    };

    const actual = attachAnimeTextEvidence(
      result,
      empty,
      relationRuntime.qualifyAnimeTextRelationRegionIds,
    );

    expect(actual).not.toBe(result);
    expect(actual.hints).toHaveLength(result.hints.length);
    for (const hint of actual.hints) {
      expect(hint).not.toHaveProperty("animeTextRegionId");
      expect(hint).not.toHaveProperty("animeTextModelRevision");
    }
  });

  it("does not assign evidence when two distinct regions are tied", () => {
    const result: OcrBboxResult = {
      hints: [
        {
          id: 1,
          x1: 100,
          y1: 100,
          x2: 130,
          y2: 160,
          reviewStatus: "deferred",
        },
      ],
      diagnostics: [],
    };
    const tied: AnimeTextDetection = {
      ...detection,
      regions: [
        { ...detection.regions[0], bbox: [90, 90, 160, 180] },
        { ...detection.regions[0], bbox: [80, 80, 150, 170] },
      ],
    };

    expect(
      attachAnimeTextEvidence(
        result,
        tied,
        relationRuntime.qualifyAnimeTextRelationRegionIds,
      ),
    ).toBe(result);
  });

  it("keeps the exact OCR result when detector inference fails", async () => {
    const result = ambiguousResult();
    const release = vi.fn();
    const onProgress = vi.fn();
    const acquireDetector = vi.fn(async () => ({
      detector: {
        detect: vi.fn(async () => {
          throw new Error("detector unavailable");
        }),
      },
      release,
    }));
    const port = createAnimeTextEvidencePort({
      dataRoot: "C:/data",
      hasPotentialRelation: relationRuntime.hasPotentialAnimeTextRelation,
      qualifyRelationRegionIds:
        relationRuntime.qualifyAnimeTextRelationRegionIds,
      acquireDetector,
      reportWarning: vi.fn(),
    });

    const actual = await port.annotate(options({ onProgress }), result);

    expect(actual).toBe(result);
    expect(release).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        progressText: "텍스트 영역 보조 분석 생략",
        progressMode: "log-only",
      }),
    );
  });

  it("cannot fail translation when optional warning and progress reporters throw", async () => {
    const result = ambiguousResult();
    const release = vi.fn();
    const consoleWarning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const port = createAnimeTextEvidencePort({
      dataRoot: "C:/data",
      hasPotentialRelation: relationRuntime.hasPotentialAnimeTextRelation,
      qualifyRelationRegionIds:
        relationRuntime.qualifyAnimeTextRelationRegionIds,
      acquireDetector: vi.fn(async () => ({
        detector: {
          detect: vi.fn(async () => {
            throw new Error("detector unavailable");
          }),
        },
        release,
      })),
      reportWarning: vi.fn(() => {
        throw new Error("warning sink unavailable");
      }),
    });

    await expect(
      port.annotate(
        options({
          onProgress: () => {
            throw new Error("progress sink unavailable");
          },
        }),
        result,
      ),
    ).resolves.toBe(result);
    expect(release).toHaveBeenCalledOnce();
    expect(consoleWarning).toHaveBeenCalled();
  });

  it("reuses one detector lease for selected pages in a batch", async () => {
    const first = ambiguousResult();
    const second: OcrBboxResult = { hints: [], diagnostics: [] };
    const detect = vi.fn(async () => detection);
    const release = vi.fn();
    const acquireDetector = vi.fn(async () => ({
      detector: { detect },
      release,
    }));
    const port = createAnimeTextEvidencePort({
      dataRoot: "C:/data",
      hasPotentialRelation: relationRuntime.hasPotentialAnimeTextRelation,
      qualifyRelationRegionIds:
        relationRuntime.qualifyAnimeTextRelationRegionIds,
      acquireDetector,
      reportWarning: vi.fn(),
    });

    const actual = await port.annotateBatch(
      [options(), options({ imagePath: "C:/pages/page-2.png" })],
      [first, second],
    );

    expect(acquireDetector).toHaveBeenCalledOnce();
    expect(detect).toHaveBeenCalledOnce();
    expect(actual[0]).not.toBe(first);
    expect(actual[1]).toBe(second);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects coordinate-frame mismatches before attaching evidence", () => {
    expect(() =>
      attachAnimeTextEvidence(
        ambiguousResult(),
        detection,
        relationRuntime.qualifyAnimeTextRelationRegionIds,
        {
          width: 501,
          height: 800,
        },
      ),
    ).toThrow("이미지 크기 불일치");
  });
});
