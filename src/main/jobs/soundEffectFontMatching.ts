import type { TranslationOptions } from "../appSettings";
import type { MangaPage } from "../../shared/libraryTypes";
import type { SoundEffectReviewRegion } from "../../shared/soundEffectReview";
import type { TranslationBlock } from "../../shared/textTypes";
import { runAutomaticFontMatchingV2PageStage } from "../pipeline/automaticFontMatchingV2PageStage";
import type { FontMatchingPageInferencePort } from "../pipeline/fontMatchingPagePixelInferenceTypes";
import { buildPageOptions } from "../pipeline/options";
import { buildTranslatedOverlayBlocks } from "../pipeline/translatedPageResult";
import { toReviewedSoundEffectBlock } from "./reviewedSoundEffectBlock";
import {
  buildReviewedSoundEffectOverlayItem,
  type ValidatedSoundEffectTranslation,
} from "./soundEffectTranslationResult";

type SoundEffectResolvedEntry = {
  regionId: string;
  block: TranslationBlock;
};

type SoundEffectFontMatchingDependencies = {
  runFontMatching: typeof runAutomaticFontMatchingV2PageStage;
  buildBlocks: typeof buildTranslatedOverlayBlocks;
};

const productionDependencies: SoundEffectFontMatchingDependencies = {
  runFontMatching: runAutomaticFontMatchingV2PageStage,
  buildBlocks: buildTranslatedOverlayBlocks,
};

/**
 * Builds reviewed SFX blocks through the same pixel-only font matching
 * boundary as ordinary page translation. The caller runs this only after the
 * translation endpoint has been disposed so the two model families do not
 * occupy the selected accelerator together.
 */
export async function buildFontMatchedSoundEffectEntries(
  {
    baseOptions,
    fontMatchingPort,
    jobId,
    page,
    pageIndex,
    regions,
    signal,
    translations,
  }: {
    baseOptions: TranslationOptions;
    fontMatchingPort?: FontMatchingPageInferencePort;
    jobId: string;
    page: MangaPage;
    pageIndex: number;
    regions: readonly SoundEffectReviewRegion[];
    signal: AbortSignal;
    translations: readonly ValidatedSoundEffectTranslation[];
  },
  dependencies: SoundEffectFontMatchingDependencies = productionDependencies,
): Promise<SoundEffectResolvedEntry[]> {
  const regionById = new Map(regions.map((region) => [region.id, region]));
  const pairs = translations.map((translation, index) => {
    const region = regionById.get(translation.regionId);
    if (!region) {
      throw new Error(
        `저장된 효과음 후보 ${translation.regionId}를 찾지 못했습니다.`,
      );
    }
    return {
      region,
      regionId: translation.regionId,
      item: buildReviewedSoundEffectOverlayItem(region, translation, index),
    };
  });
  if (pairs.length === 0) return [];

  const blockRunId = `${jobId}-sfx`;
  const pageOptions = buildPageOptions(baseOptions, page, pageIndex, 1);
  pageOptions.abortSignal = signal;
  const items = pairs.map(({ item }) => item);
  const fontMatchingPageInference = pageOptions.autoFontMatching
    ? await dependencies.runFontMatching({
        jobId: blockRunId,
        page,
        pageOptions,
        items,
        port: fontMatchingPort,
      })
    : undefined;
  const blocks = dependencies.buildBlocks({
    fontMatchingPageInference,
    items,
    jobId: blockRunId,
    page,
    pageOptions,
  });
  return pairs.map(({ regionId }, index) => ({
    regionId,
    block: toReviewedSoundEffectBlock(blocks[index]),
  }));
}
