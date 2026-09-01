import type { OcrPipeline } from "./settingsTypes";

export const OCR_PIPELINES = ["hayai", "paddle-legacy"] as const;

const OCR_ENGINE_PROFILES = {
  hayai: {
    displayName: "HayaiOCR",
    bboxProvider: "hayai-regions",
    rendererKeyPrefix: "hayaiOcr",
  },
  "paddle-legacy": {
    displayName: "Paddle OCR",
    bboxProvider: "paddleocr",
    rendererKeyPrefix: "ocr",
  },
} as const satisfies Record<
  OcrPipeline,
  {
    displayName: string;
    bboxProvider: "hayai-regions" | "paddleocr";
    rendererKeyPrefix: string;
  }
>;

export function isHayaiOcrPipeline(
  pipeline: OcrPipeline | null | undefined,
): pipeline is "hayai" {
  return pipeline === "hayai";
}

export function resolveOcrPipeline(
  pipeline: OcrPipeline | null | undefined,
): OcrPipeline {
  return pipeline ?? "paddle-legacy";
}

export function resolveOcrEngineDisplayName(
  pipeline: OcrPipeline | null | undefined,
): string {
  return OCR_ENGINE_PROFILES[resolveOcrPipeline(pipeline)].displayName;
}

export function resolveOcrBboxProvider(
  pipeline: OcrPipeline | null | undefined,
): "hayai-regions" | "paddleocr" {
  return OCR_ENGINE_PROFILES[resolveOcrPipeline(pipeline)].bboxProvider;
}

export function resolveOcrRendererKeyPrefix(
  pipeline: OcrPipeline | null | undefined,
): "hayaiOcr" | "ocr" {
  return OCR_ENGINE_PROFILES[resolveOcrPipeline(pipeline)].rendererKeyPrefix;
}
