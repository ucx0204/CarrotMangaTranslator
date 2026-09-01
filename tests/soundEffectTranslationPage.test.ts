import { describe, expect, it, vi } from "vitest";
import {
  translateStoredSoundEffectRegions,
  type SoundEffectTranslationPageDependencies,
} from "../src/main/jobs/soundEffectTranslationPage";
import type { TranslationOptions } from "../src/main/appSettings";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { SoundEffectReviewRegion } from "../src/shared/soundEffectReview";

describe("sound-effect translation page", () => {
  it("sends every SFX candidate in its own two-image model request", async () => {
    const regions = [region("FX001", "ドン"), region("FX002", "ガタン")];
    const buildImages = vi.fn(async (_page, candidate) => ({
      context: {
        path: `C:/run/${candidate.id}-context.png`,
        width: 784,
        height: 1176,
      },
      crop: {
        path: `C:/run/${candidate.id}-crop.png`,
        width: 512,
        height: 768,
      },
    }));
    const requests: TranslationOptions[] = [];
    const requestTranslation: SoundEffectTranslationPageDependencies["requestTranslation"] =
      vi.fn(async ({ pageOptions }) => {
        requests.push(pageOptions);
        const candidate = pageOptions.soundEffectTranslationRegions?.[0];
        return {
          outputText: JSON.stringify({
            items: [
              {
                regionId: candidate?.regionId,
                verdict: "sound",
                confirmedSource: candidate?.recognizedText,
                translation: candidate?.regionId === "FX001" ? "쿵" : "덜컹",
                confidence: 0.9,
              },
            ],
          }),
        } as never;
      });
    const result = await translateStoredSoundEffectRegions(
      {
        abortController: new AbortController(),
        context: { decodeImage: vi.fn() } as never,
        endpoint: { server: { baseUrl: "http://model" } } as never,
        pageIndex: 0,
        run: {
          baseOptions: {
            outputDir: "C:/run",
            targetLanguage: "ko",
            ocrPipeline: "hayai-ocr",
          },
          progressContext: {
            jobId: "job-1",
            emit: vi.fn(),
            progressTotal: 1,
            pageTotal: 1,
            ocrPipeline: "hayai-ocr",
          },
          runtime: { parseJsonLenient: JSON.parse },
        } as never,
        runPaths: { runDir: "C:/run" } as never,
        target: {
          page: makePage(regions),
          revision: "page-v1:0000000000000000" as never,
          regions,
        },
        workContext: undefined,
      },
      {
        buildImages,
        requestTranslation,
      } as SoundEffectTranslationPageDependencies,
    );

    expect(result.items.map(({ regionId }) => regionId)).toEqual([
      "FX001",
      "FX002",
    ]);
    expect(buildImages).toHaveBeenCalledTimes(2);
    expect(requestTranslation).toHaveBeenCalledTimes(2);
    expect(
      requests.map((request) => ({
        context: request.imagePath,
        crop: request.soundEffectTargetCropPath,
        regions: request.soundEffectTranslationRegions,
      })),
    ).toEqual([
      expect.objectContaining({
        context: "C:/run/FX001-context.png",
        crop: "C:/run/FX001-crop.png",
        regions: [expect.objectContaining({ regionId: "FX001" })],
      }),
      expect.objectContaining({
        context: "C:/run/FX002-context.png",
        crop: "C:/run/FX002-crop.png",
        regions: [expect.objectContaining({ regionId: "FX002" })],
      }),
    ]);
  });

  it("passes a concrete quality failure back to the one visual retry", async () => {
    const regions = [region("FX001", "バタン")];
    const requests: TranslationOptions[] = [];
    const requestTranslation: SoundEffectTranslationPageDependencies["requestTranslation"] =
      vi.fn(async ({ pageOptions }) => {
        requests.push(pageOptions);
        return {
          outputText: JSON.stringify({
            items: [
              {
                regionId: "FX001",
                verdict: "sound",
                confirmedSource: "バタン",
                translation:
                  pageOptions.translationAttempt === 1 ? "철컥" : "쾅",
                confidence: 0.9,
              },
            ],
          }),
        } as never;
      });
    const result = await translateStoredSoundEffectRegions(
      {
        abortController: new AbortController(),
        context: { decodeImage: vi.fn() } as never,
        endpoint: { server: { baseUrl: "http://model" } } as never,
        pageIndex: 0,
        run: {
          baseOptions: {
            outputDir: "C:/run",
            targetLanguage: "ko",
            ocrPipeline: "hayai-ocr",
          },
          progressContext: {
            jobId: "job-1",
            emit: vi.fn(),
            progressTotal: 1,
            pageTotal: 1,
            ocrPipeline: "hayai-ocr",
          },
          runtime: { parseJsonLenient: JSON.parse },
        } as never,
        runPaths: { runDir: "C:/run" } as never,
        target: {
          page: makePage(regions),
          revision: "page-v1:0000000000000000" as never,
          regions,
        },
        workContext: undefined,
      },
      {
        buildImages: vi.fn(async () => ({
          context: { path: "C:/run/context.png", width: 784, height: 1176 },
          crop: { path: "C:/run/crop.png", width: 512, height: 768 },
        })),
        requestTranslation,
      },
    );

    expect(requests).toHaveLength(2);
    expect(requests[1]?.soundEffectRetryFeedback).toContain("철컥이 아닙니다");
    expect(result.items).toEqual([
      expect.objectContaining({ translation: "쾅" }),
    ]);
  });
});

function region(id: string, recognizedText: string): SoundEffectReviewRegion {
  return {
    id,
    bbox: { x: 100, y: 120, w: 140, h: 180 },
    detectorConfidence: 0.9,
    recognizedText,
  };
}

function makePage(regions: SoundEffectReviewRegion[]): MangaPage {
  return {
    id: "page-1",
    name: "001.jpg",
    imagePath: "C:/manga/001.jpg",
    dataUrl: "",
    width: 1200,
    height: 1800,
    blocks: [],
    soundEffectReview: {
      contractVersion: 3,
      producer: "hayai-regions-v1",
      regionOverrides: [],
      manualRegions: [],
      regions,
      resolvedRegions: [],
    },
    analysisStatus: "completed",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}
