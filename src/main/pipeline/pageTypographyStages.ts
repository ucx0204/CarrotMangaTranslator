import { runAutomaticFontMatchingV2PageStage } from "./automaticFontMatchingV2PageStage";
import { logPipelineInfo } from "./pipelineLogger";
import { estimatePageSourceFontSizes } from "./sourceFontSizeEstimator";

type AutomaticStageOptions = Parameters<
  typeof runAutomaticFontMatchingV2PageStage
>[0];

export type PageTypographyStageDependencies = Readonly<{
  runFontMatching: typeof runAutomaticFontMatchingV2PageStage;
  estimateSourceFontSizes: typeof estimatePageSourceFontSizes;
  logInfo: typeof logPipelineInfo;
}>;

const defaultDependencies: PageTypographyStageDependencies = {
  runFontMatching: runAutomaticFontMatchingV2PageStage,
  estimateSourceFontSizes: estimatePageSourceFontSizes,
  logInfo: logPipelineInfo,
};

export async function runPageTypographyStages(
  options: AutomaticStageOptions,
  dependencies: PageTypographyStageDependencies = defaultDependencies,
): Promise<{
  pixelInference: Awaited<
    ReturnType<typeof runAutomaticFontMatchingV2PageStage>
  >;
  sourceFontSizeEstimates: Awaited<
    ReturnType<typeof estimatePageSourceFontSizes>
  >;
}> {
  const startedAt = performance.now();
  const fontMatchingTask = measureTypographyStage(() =>
    dependencies.runFontMatching(options),
  );
  const fontSizeEnabled =
    (options.pageOptions.aiFontSizeMatching ??
      options.pageOptions.fontSizeAutoFit) === true;
  // Pixel font matching already runs in its own worker thread. Source-size
  // measurement is independent, so overlap both CPU stages instead of making
  // every page pay their wall times serially.
  const sourceFontSizeTask = measureTypographyStage(() =>
    dependencies.estimateSourceFontSizes({
      enabled: fontSizeEnabled,
      items: options.items,
      page: options.page,
      signal: options.pageOptions.abortSignal,
    }),
  );
  const [fontMatching, fontSize] = await Promise.all([
    fontMatchingTask,
    sourceFontSizeTask,
  ]);
  if (options.pageOptions.autoFontMatching || fontSizeEnabled) {
    dependencies.logInfo("Page typography stages completed", {
      jobId: options.jobId,
      pageId: options.page.id,
      itemCount: options.items.length,
      autoFontMatchingEnabled: options.pageOptions.autoFontMatching === true,
      aiFontSizeMatchingEnabled: fontSizeEnabled,
      fontMatchingMs: Math.round(fontMatching.elapsedMs),
      sourceFontSizeMs: Math.round(fontSize.elapsedMs),
      wallMs: Math.round(performance.now() - startedAt),
    });
  }
  return {
    pixelInference: fontMatching.value,
    sourceFontSizeEstimates: fontSize.value,
  };
}

async function measureTypographyStage<T>(
  run: () => Promise<T>,
): Promise<{ value: T; elapsedMs: number }> {
  const startedAt = performance.now();
  const value = await run();
  return { value, elapsedMs: performance.now() - startedAt };
}
