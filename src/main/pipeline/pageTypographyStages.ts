import { runAutomaticFontMatchingV2PageStage } from "./automaticFontMatchingV2PageStage";
import { estimatePageSourceFontSizes } from "./sourceFontSizeEstimator";

type AutomaticStageOptions = Parameters<
  typeof runAutomaticFontMatchingV2PageStage
>[0];

export async function runPageTypographyStages(
  options: AutomaticStageOptions,
): Promise<{
  pixelInference: Awaited<
    ReturnType<typeof runAutomaticFontMatchingV2PageStage>
  >;
  sourceFontSizeEstimates: Awaited<
    ReturnType<typeof estimatePageSourceFontSizes>
  >;
}> {
  const pixelInference = await runAutomaticFontMatchingV2PageStage(options);
  const sourceFontSizeEstimates = await estimatePageSourceFontSizes({
    enabled:
      options.pageOptions.fontSizeAutoFit === true &&
      !options.pageOptions.keepBlocksMode,
    items: options.items,
    page: options.page,
    signal: options.pageOptions.abortSignal,
  });
  return { pixelInference, sourceFontSizeEstimates };
}
