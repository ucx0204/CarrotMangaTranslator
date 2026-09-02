import { describe, expect, it, vi } from "vitest";
import type { TranslationOptions } from "../src/main/appSettings";
import { buildFontMatchedSoundEffectEntries } from "../src/main/jobs/soundEffectFontMatching";
import { overlayItemToBlock } from "../src/main/pipeline/overlayItems";
import { buildTranslatedOverlayBlocks } from "../src/main/pipeline/translatedPageResult";
import type { OverlayItem } from "../src/main/pipeline/types";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { SoundEffectReviewRegion } from "../src/shared/soundEffectReview";

describe("dedicated SFX font matching", () => {
  it("runs the shared pixel stage and keeps its selected font on the reviewed block", async () => {
    const runFontMatching = vi.fn(async () => ({
      pixelInferenceByBlockId: new Map(),
    }));
    const buildBlocks = vi.fn(
      (options: Parameters<typeof buildTranslatedOverlayBlocks>[0]) =>
        options.items.map((item: OverlayItem, index: number) => ({
          ...overlayItemToBlock(item, options.page, index, options.jobId),
          fontFamily: "dohyeon",
          fontRole: "sfx_impact" as const,
          fontRoleConfidence: 0.98,
        })),
    );

    const entries = await buildFontMatchedSoundEffectEntries(
      makeInput({ autoFontMatching: true }),
      { runFontMatching, buildBlocks },
    );

    expect(runFontMatching).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-1-sfx" }),
    );
    expect(buildBlocks).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-1-sfx",
        pageOptions: expect.objectContaining({ autoFontMatching: true }),
      }),
    );
    expect(entries).toEqual([
      expect.objectContaining({
        regionId: "FX001",
        block: expect.objectContaining({
          autoFitText: true,
          fontFamily: "dohyeon",
          fontSizePx: 40,
          textRole: "sound",
        }),
      }),
    ]);
    expect(entries[0]?.block).not.toHaveProperty("fontRole");
    expect(entries[0]?.block).not.toHaveProperty("fontRoleConfidence");
    expect(entries[0]?.block).not.toHaveProperty("inpaintExcluded");
    expect(entries[0]?.block).not.toHaveProperty("reviewStatus");
  });

  it("does not start pixel inference when the option is off", async () => {
    const runFontMatching = vi.fn(async () => ({
      pixelInferenceByBlockId: new Map(),
    }));
    const buildBlocks = vi.fn(
      (options: Parameters<typeof buildTranslatedOverlayBlocks>[0]) =>
        options.items.map((item: OverlayItem, index: number) =>
          overlayItemToBlock(item, options.page, index, options.jobId),
        ),
    );

    const entries = await buildFontMatchedSoundEffectEntries(
      makeInput({ autoFontMatching: undefined }),
      { runFontMatching, buildBlocks },
    );

    expect(runFontMatching).not.toHaveBeenCalled();
    expect(entries[0]?.block.fontFamily).toBeUndefined();
  });
});

function makeInput(baseOptions: Partial<TranslationOptions>) {
  return {
    baseOptions: {
      outputDir: "C:/qa/output",
      ...baseOptions,
    } as TranslationOptions,
    jobId: "job-1",
    page: PAGE,
    pageIndex: 0,
    regions: [REGION],
    signal: new AbortController().signal,
    translations: [
      {
        regionId: "FX001",
        verdict: "sound" as const,
        confirmedSource: "ドン",
        translation: "쾅",
        confidence: 0.96,
      },
    ],
  };
}

const PAGE: MangaPage = {
  id: "page-1",
  name: "001.png",
  imagePath: "C:/qa/001.png",
  dataUrl: "",
  width: 1000,
  height: 1400,
  blocks: [],
  analysisStatus: "completed",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const REGION: SoundEffectReviewRegion = {
  id: "FX001",
  bbox: { x: 100, y: 200, w: 220, h: 160 },
  detectorConfidence: 0.94,
  recognizedText: "ドン",
};
