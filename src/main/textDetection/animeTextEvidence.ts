import type { TranslationOptions } from "../appSettings";
import type { OcrGroupingEvidencePort } from "../pipeline/ocrGroupingEvidencePort";
import type { OcrBboxResult } from "../pipeline/types";
import type { RuntimeAssetProgress } from "../runtimeSupport/modelDownloads";
import type { AnimeTextDetection } from "./animeTextContracts";
import {
  acquireAnimeTextDetector,
  disposeCachedAnimeTextDetector,
} from "./animeTextDetectorPool";
import {
  attachAnimeTextEvidence as projectAnimeTextEvidence,
  type QualifyAnimeTextRelationRegionIds,
} from "./animeTextEvidenceProjection";
import { logAnimeTextWarning } from "./animeTextLogger";

type AnimeTextDetectorLease = {
  detector: {
    detect: (
      input: string,
      signal?: AbortSignal,
    ) => Promise<AnimeTextDetection>;
  };
  release: () => void;
};
type AcquireAnimeTextDetector = (options: {
  dataRoot: string;
  signal?: AbortSignal;
  onProgress?: (progress: RuntimeAssetProgress) => void;
}) => Promise<AnimeTextDetectorLease>;
type HasPotentialAnimeTextRelation = (hints: unknown[]) => boolean;

type EvidencePortOptions = {
  dataRoot: string;
  hasPotentialRelation: HasPotentialAnimeTextRelation;
  qualifyRelationRegionIds: QualifyAnimeTextRelationRegionIds;
  acquireDetector?: AcquireAnimeTextDetector;
  releaseIdleResources?: typeof disposeCachedAnimeTextDetector;
  reportWarning?: typeof logAnimeTextWarning;
};

export function createAnimeTextEvidencePort(
  options: EvidencePortOptions,
): OcrGroupingEvidencePort {
  const acquireDetector = options.acquireDetector ?? acquireAnimeTextDetector;
  const reportWarning = options.reportWarning ?? logAnimeTextWarning;
  const annotate = (
    optionsList: TranslationOptions[],
    results: OcrBboxResult[],
  ) =>
    annotateSelectedPages({
      dataRoot: options.dataRoot,
      optionsList,
      results,
      acquireDetector,
      reportWarning,
      hasPotentialRelation: options.hasPotentialRelation,
      qualifyRelationRegionIds: options.qualifyRelationRegionIds,
    });
  return {
    annotate: async (translationOptions, result) => {
      const annotated = await annotate([translationOptions], [result]);
      return annotated[0] ?? result;
    },
    annotateBatch: annotate,
    releaseIdleResources:
      options.releaseIdleResources ?? disposeCachedAnimeTextDetector,
  };
}

export function shouldRunAnimeTextDetector(
  options: TranslationOptions,
  result: OcrBboxResult,
  hasPotentialRelation: HasPotentialAnimeTextRelation,
): boolean {
  if (
    options.skipOcrBboxHints ||
    result.noTextDetected ||
    !options.imagePath ||
    result.hints.length === 0
  ) {
    return false;
  }
  return hasPotentialRelation(result.hints);
}

export function attachAnimeTextEvidence(
  result: OcrBboxResult,
  detection: AnimeTextDetection,
  qualifyRelationRegionIds: QualifyAnimeTextRelationRegionIds,
  expectedDimensions?: { width?: number; height?: number },
): OcrBboxResult {
  return projectAnimeTextEvidence(
    result,
    detection,
    qualifyRelationRegionIds,
    expectedDimensions,
  );
}

type AnnotateSelectedPagesOptions = {
  dataRoot: string;
  optionsList: TranslationOptions[];
  results: OcrBboxResult[];
  acquireDetector: AcquireAnimeTextDetector;
  reportWarning: typeof logAnimeTextWarning;
  hasPotentialRelation: HasPotentialAnimeTextRelation;
  qualifyRelationRegionIds: QualifyAnimeTextRelationRegionIds;
};

async function annotateSelectedPages({
  dataRoot,
  optionsList,
  results,
  acquireDetector,
  reportWarning,
  hasPotentialRelation,
  qualifyRelationRegionIds,
}: AnnotateSelectedPagesOptions): Promise<OcrBboxResult[]> {
  if (optionsList.length !== results.length) {
    throw new Error("OCR options and results must have matching lengths.");
  }
  const selected = selectEligiblePages(
    optionsList,
    results,
    hasPotentialRelation,
    reportWarning,
  );
  if (selected.length === 0) {
    return results;
  }
  const lease = await acquireDetectorOrNoop(
    dataRoot,
    selected[0].translationOptions,
    acquireDetector,
    reportWarning,
  );
  if (!lease) {
    return results;
  }
  const annotated = [...results];
  try {
    await annotateWithLease(
      selected,
      annotated,
      lease,
      qualifyRelationRegionIds,
      reportWarning,
    );
  } finally {
    lease.release();
  }
  return annotated.every((value, index) => value === results[index])
    ? results
    : annotated;
}

type SelectedPage = {
  translationOptions: TranslationOptions;
  result: OcrBboxResult;
  index: number;
};

function selectEligiblePages(
  optionsList: TranslationOptions[],
  results: OcrBboxResult[],
  hasPotentialRelation: HasPotentialAnimeTextRelation,
  reportWarning: typeof logAnimeTextWarning,
): SelectedPage[] {
  const selected: SelectedPage[] = [];
  for (let index = 0; index < optionsList.length; index += 1) {
    const result = results[index];
    const translationOptions = optionsList[index];
    if (!result) {
      continue;
    }
    try {
      if (
        shouldRunAnimeTextDetector(
          translationOptions,
          result,
          hasPotentialRelation,
        )
      ) {
        selected.push({ translationOptions, result, index });
      }
    } catch (error) {
      reportDetectorFailure(translationOptions, error, reportWarning);
    }
  }
  return selected;
}

async function acquireDetectorOrNoop(
  dataRoot: string,
  options: TranslationOptions,
  acquireDetector: AcquireAnimeTextDetector,
  reportWarning: typeof logAnimeTextWarning,
): Promise<AnimeTextDetectorLease | null> {
  try {
    return await acquireDetector({
      dataRoot,
      signal: options.abortSignal,
      onProgress: (progress) =>
        reportProgressSafely(
          options,
          {
            phase: "ocr_preparing",
            ...progress,
          },
          reportWarning,
        ),
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    reportDetectorFailure(options, error, reportWarning);
    return null;
  }
}

async function annotateWithLease(
  selected: SelectedPage[],
  annotated: OcrBboxResult[],
  lease: AnimeTextDetectorLease,
  qualifyRelationRegionIds: QualifyAnimeTextRelationRegionIds,
  reportWarning: typeof logAnimeTextWarning,
): Promise<void> {
  for (const item of selected) {
    try {
      const detection = await lease.detector.detect(
        item.translationOptions.imagePath,
        item.translationOptions.abortSignal,
      );
      annotated[item.index] = attachAnimeTextEvidence(
        item.result,
        detection,
        qualifyRelationRegionIds,
        {
          width: item.translationOptions.imageWidth,
          height: item.translationOptions.imageHeight,
        },
      );
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      reportDetectorFailure(item.translationOptions, error, reportWarning);
    }
  }
}

function reportDetectorFailure(
  options: TranslationOptions,
  error: unknown,
  reportWarning: typeof logAnimeTextWarning,
): void {
  const message = error instanceof Error ? error.message : String(error);
  reportWarningSafely(reportWarning, "optional evidence unavailable", {
    pageId: options.pageId ?? null,
    imagePath: options.imagePath,
    error,
  });
  reportProgressSafely(
    options,
    {
      phase: "ocr_running",
      progressText: "텍스트 영역 보조 분석 생략",
      detail: message,
      progressMode: "log-only",
    },
    reportWarning,
  );
}

function reportProgressSafely(
  options: TranslationOptions,
  progress: Parameters<NonNullable<TranslationOptions["onProgress"]>>[0],
  reportWarning: typeof logAnimeTextWarning,
): void {
  if (!options.onProgress) {
    return;
  }
  try {
    options.onProgress(progress);
  } catch (error) {
    reportWarningSafely(reportWarning, "progress callback failed", {
      pageId: options.pageId ?? null,
      imagePath: options.imagePath,
      error,
    });
  }
}

function reportWarningSafely(
  reportWarning: typeof logAnimeTextWarning,
  detail: string,
  context: Record<string, unknown>,
): void {
  try {
    reportWarning(`anime-text-yolo ${detail}`, context);
  } catch (error) {
    console.warn("anime-text-yolo warning reporter failed", {
      detail,
      context,
      error,
    });
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      (error as Error & { code?: unknown }).code === "ABORT_ERR")
  );
}
