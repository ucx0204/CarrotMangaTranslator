import type { ComicPageDetectionResult } from "../bubbleLayout/contracts";
import { ensureKoharuLayoutAssets } from "../bubbleLayout/assets";
import { detectKoharuPageLayout } from "../bubbleLayout/detector";

export type PageTextRegionDetectionOptions = {
  dataRoot: string;
  imagePath: string;
  signal?: AbortSignal;
};

/**
 * Stable application boundary for the page text-region detector.
 *
 * The detector implementation and its asset names stay behind this adapter so
 * OCR orchestration depends on capabilities, not another application's brand.
 */
export async function detectPageTextRegions(
  options: PageTextRegionDetectionOptions,
): Promise<ComicPageDetectionResult> {
  const assets = await ensureKoharuLayoutAssets({
    dataRoot: options.dataRoot,
    signal: options.signal,
  });
  return detectKoharuPageLayout({
    imagePath: options.imagePath,
    modelPath: assets.modelPath,
    signal: options.signal,
  });
}
