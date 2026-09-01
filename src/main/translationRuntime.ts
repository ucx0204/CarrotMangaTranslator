import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { disposeCachedInpaintingEngines } from "./inpainting/inpaintingEnginePool";
import {
  createTranslationRuntimePort,
  type GpuMemoryCoordinator,
  type HayaiOcrRegionPrepassPort,
  type TranslationRuntimePort,
} from "./pipeline/translationRuntimePort";
import { loadRuntimeModules } from "./pipeline/runtimeModules";
import type { OcrBboxResult, RuntimeModules } from "./pipeline/types";
import { getAppPaths } from "./appPaths";
import { createAnimeTextEvidencePort } from "./textDetection/animeTextEvidence";
import type { OcrGroupingEvidencePort } from "./pipeline/ocrGroupingEvidencePort";
import { prepareHayaiRegions } from "./textDetection/hayaiRegionPrepass";
import type { HayaiRegionManifest } from "./textDetection/hayaiRegionGeometry";
import type { SoundEffectReviewRegion } from "../shared/soundEffectReview";
import { disposeCachedKoharuLayoutSessions } from "./bubbleLayout/session";

const gpuMemoryCoordinator: GpuMemoryCoordinator = {
  releaseIdleResources: disposeCachedInpaintingEngines,
};

const hayaiRegionPrepass: HayaiOcrRegionPrepassPort = {
  prepare: async (options) => {
    const prepared = await prepareHayaiRegions(options);
    return {
      manifestPath: prepared.manifestPath,
      finalize: (result) =>
        attachEffectReviewRegions(result, prepared.manifest, options.outputDir),
    };
  },
  releaseDetectorResources: async (_reason) =>
    disposeCachedKoharuLayoutSessions(),
};

type TranslationRuntimeResources = {
  runtime: RuntimeModules;
  groupingEvidence: OcrGroupingEvidencePort;
};

let runtimeResources: TranslationRuntimeResources | null = null;

function getTranslationRuntimeResources(): TranslationRuntimeResources {
  if (runtimeResources) {
    return runtimeResources;
  }
  const runtime = loadRuntimeModules();
  const groupingEvidence = createAnimeTextEvidencePort({
    dataRoot: getAppPaths().dataRoot,
    hasPotentialRelation:
      runtime.animeTextRelations.hasPotentialAnimeTextRelation,
    qualifyRelationRegionIds:
      runtime.animeTextRelations.qualifyAnimeTextRelationRegionIds,
  });
  runtimeResources = { runtime, groupingEvidence };
  return runtimeResources;
}

export function loadTranslationRuntimePort(): TranslationRuntimePort {
  const { groupingEvidence, runtime } = getTranslationRuntimeResources();
  return createTranslationRuntimePort({
    gpuMemory: gpuMemoryCoordinator,
    groupingEvidence,
    hayaiRegionPrepass,
    runtime,
  });
}

export async function disposeTranslationRuntimeResources(
  reason: string,
): Promise<boolean> {
  const [groupingEvidenceDisposed, regionDetectorDisposed] = await Promise.all([
    runtimeResources?.groupingEvidence.releaseIdleResources(reason) ??
      Promise.resolve(false),
    disposeCachedKoharuLayoutSessions(),
  ]);
  return groupingEvidenceDisposed || regionDetectorDisposed;
}

async function attachEffectReviewRegions(
  result: OcrBboxResult,
  manifest: HayaiRegionManifest,
  outputDir: string,
): Promise<OcrBboxResult> {
  const recognized = await readRecognizedEffectText(
    join(outputDir, "ocr-bbox-hints.json"),
  );
  const effectReviewRegions: SoundEffectReviewRegion[] =
    manifest.effectRegions.map((region) => {
      const text = recognized.get(region.regionId)?.trim();
      return {
        id: region.regionId,
        bbox: {
          x: clampNormalized((region.bbox[0] / manifest.width) * 1000),
          y: clampNormalized((region.bbox[1] / manifest.height) * 1000),
          w: clampNormalized(
            ((region.bbox[2] - region.bbox[0]) / manifest.width) * 1000,
          ),
          h: clampNormalized(
            ((region.bbox[3] - region.bbox[1]) / manifest.height) * 1000,
          ),
        },
        detectorConfidence: region.detectorConfidence,
        sourceDetectionIds: region.sourceDetectionIds,
        ...(text ? { recognizedText: text } : {}),
      };
    });
  return { ...result, effectReviewRegions };
}

async function readRecognizedEffectText(
  outputPath: string,
): Promise<Map<string, string>> {
  try {
    const payload = JSON.parse(await readFile(outputPath, "utf8")) as {
      effectReviewRegions?: Array<{
        regionId?: unknown;
        recognizedText?: unknown;
        ocrText?: unknown;
      }>;
    };
    return new Map(
      (payload.effectReviewRegions ?? []).flatMap((item) => {
        const id = typeof item.regionId === "string" ? item.regionId : "";
        const text =
          typeof item.recognizedText === "string"
            ? item.recognizedText
            : typeof item.ocrText === "string"
              ? item.ocrText
              : "";
        return id ? [[id, text] as const] : [];
      }),
    );
  } catch (error) {
    void error;
    return new Map();
  }
}

function clampNormalized(value: number): number {
  return Math.round(Math.min(1000, Math.max(0, value)) * 1000) / 1000;
}
