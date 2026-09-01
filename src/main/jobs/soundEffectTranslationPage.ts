import { join } from "node:path";
import { getRunPaths } from "../library";
import type { startAnalysisEndpointSession } from "../pipeline/endpointSession";
import { throwIfAborted } from "../pipeline/failure";
import {
  buildRequestPageOptions,
  requestPageTranslation,
} from "../pipeline/pageResultBuilder";
import type { prepareAnalysisRun } from "../pipeline/prepareAnalysisRun";
import type { OcrBboxResult } from "../pipeline/types";
import type { TranslationJobContext } from "./translationJobTypes";
import { buildSoundEffectTranslationImages } from "./soundEffectTranslationImages";
import {
  validateSoundEffectTranslationResponse,
  type ValidatedSoundEffectTranslation,
} from "./soundEffectTranslationResult";
import type { StoredSoundEffectTarget } from "./soundEffectTranslationTargets";

export type SoundEffectTranslationPageDependencies = {
  buildImages: typeof buildSoundEffectTranslationImages;
  requestTranslation: typeof requestPageTranslation;
};

const productionDependencies: SoundEffectTranslationPageDependencies = {
  buildImages: buildSoundEffectTranslationImages,
  requestTranslation: requestPageTranslation,
};

export async function translateStoredSoundEffectRegions(
  {
    abortController,
    context,
    endpoint,
    pageIndex,
    run,
    runPaths,
    target,
    workContext,
  }: {
    abortController: AbortController;
    context: TranslationJobContext;
    endpoint: Awaited<ReturnType<typeof startAnalysisEndpointSession>>;
    pageIndex: number;
    run: Awaited<ReturnType<typeof prepareAnalysisRun>>;
    runPaths: Awaited<ReturnType<typeof getRunPaths>>;
    target: StoredSoundEffectTarget;
    workContext: Parameters<typeof buildRequestPageOptions>[0]["workContext"];
  },
  dependencies: SoundEffectTranslationPageDependencies = productionDependencies,
): Promise<{
  items: ValidatedSoundEffectTranslation[];
  warnings: string[];
}> {
  const items: ValidatedSoundEffectTranslation[] = [];
  const warnings: string[] = [];
  for (const region of target.regions) {
    const translated = await translateOneStoredSoundEffectRegion({
      abortController,
      context,
      endpoint,
      pageIndex,
      region,
      run,
      runPaths,
      target,
      workContext,
      dependencies,
    });
    items.push(...translated.items);
    warnings.push(...translated.warnings);
  }
  return { items, warnings };
}

async function translateOneStoredSoundEffectRegion(
  input: Omit<RequestOneRegionInput, "attempt">,
): Promise<{
  items: ValidatedSoundEffectTranslation[];
  warnings: string[];
}> {
  const first = await requestAndValidateOneRegion({ ...input, attempt: 1 });
  if (first.retryRegionIds.length === 0) {
    return { items: first.valid, warnings: first.warnings };
  }
  const retry = await requestAndValidateOneRegion({
    ...input,
    attempt: 2,
    retryFeedback: first.warnings.join(" "),
  });
  const warnings = [...first.warnings, ...retry.warnings];
  if (retry.retryRegionIds.length > 0) {
    warnings.push(
      `${input.target.page.name} / ${input.region.id}: 이미지 재판독 후에도 pending으로 남겼습니다.`,
    );
  }
  return { items: retry.valid, warnings };
}

type RequestOneRegionInput = {
  abortController: AbortController;
  context: TranslationJobContext;
  endpoint: Awaited<ReturnType<typeof startAnalysisEndpointSession>>;
  pageIndex: number;
  region: StoredSoundEffectTarget["regions"][number];
  run: Awaited<ReturnType<typeof prepareAnalysisRun>>;
  runPaths: Awaited<ReturnType<typeof getRunPaths>>;
  target: StoredSoundEffectTarget;
  workContext: Parameters<typeof buildRequestPageOptions>[0]["workContext"];
  attempt: number;
  retryFeedback?: string;
  dependencies: SoundEffectTranslationPageDependencies;
};

async function requestAndValidateOneRegion({
  abortController,
  context,
  endpoint,
  pageIndex,
  region,
  run,
  runPaths,
  target,
  workContext,
  attempt,
  retryFeedback,
  dependencies,
}: RequestOneRegionInput) {
  throwIfAborted(abortController.signal);
  const pageOptions = buildRequestPageOptions({
    attempt,
    baseOptions: run.baseOptions,
    context: run.progressContext,
    maxAttempts: 2,
    ocrHintsByPageId: new Map<string, OcrBboxResult>(),
    page: target.page,
    pageIndex,
    progressPageIndex: pageIndex,
    signal: abortController.signal,
    skipOcrPrepass: true,
    workContext,
  });
  pageOptions.outputDir = join(
    runPaths.runDir,
    "pages",
    target.page.id,
    `sfx-${safePathSegment(region.id)}-attempt-${attempt}`,
  );
  const images = await dependencies.buildImages(
    target.page,
    region,
    pageOptions.outputDir,
    context.decodeImage,
    abortController.signal,
  );
  Object.assign(pageOptions, {
    imagePath: images.context.path,
    imageWidth: images.context.width,
    imageHeight: images.context.height,
    includeEnhancedVariant: false,
    soundEffectTranslationMode: true,
    soundEffectTranslationRegions: [
      {
        regionId: region.id,
        bbox: region.bbox,
        recognizedText: region.recognizedText,
        detectorConfidence: region.detectorConfidence,
      },
    ],
    soundEffectTargetCropPath: images.crop.path,
    soundEffectTargetCropWidth: images.crop.width,
    soundEffectTargetCropHeight: images.crop.height,
    soundEffectTargetMarker: "cyan-fill-magenta-outline-v1",
    ...(retryFeedback ? { soundEffectRetryFeedback: retryFeedback } : {}),
  });
  const result = await dependencies.requestTranslation({
    pageOptions,
    runtime: run.runtime,
    server: endpoint.server,
  });
  return validateSoundEffectTranslationResponse(
    run.runtime.parseJsonLenient(result.outputText),
    [region],
    pageOptions.targetLanguage ?? "ko",
    {
      allowAmbiguousKoreanMeaning: attempt > 1,
      allowOcrMismatch: attempt > 1,
    },
  );
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/gu, "_").slice(0, 80) || "region";
}
