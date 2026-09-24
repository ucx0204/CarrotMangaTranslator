import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TranslationOptions } from "../appSettings";
import { isHayaiOcrPipeline } from "../../shared/ocrEngines";
import {
  buildHayaiRegionManifest,
  type HayaiRegionManifest,
} from "./hayaiRegionGeometry";
import { detectPageTextRegions } from "./pageTextRegionDetector";

export async function prepareHayaiRegions(
  options: TranslationOptions,
  detect: typeof detectPageTextRegions = detectPageTextRegions,
): Promise<{
  manifest: HayaiRegionManifest;
  manifestPath: string;
}> {
  if (!isHayaiOcrPipeline(options.ocrPipeline)) {
    throw new Error("HayaiOCR 영역 전처리는 최신 OCR 경로에서만 실행됩니다.");
  }
  options.abortSignal?.throwIfAborted();
  options.onProgress?.({
    phase: "ocr_preparing",
    progressText: "HayaiOCR 텍스트 영역 준비 중",
    detail:
      options.ocrInputKind === "known-block-crop"
        ? "선택한 원문 영역을 다시 탐지하지 않고 그대로 판독합니다."
        : "일반 텍스트와 검토 대상 효과음을 서로 다른 영역으로 검출합니다.",
    progressMode: "indeterminate",
  });
  const manifest =
    options.ocrInputKind === "known-block-crop"
      ? buildKnownBlockManifest(options)
      : await detectHayaiManifest(options, detect);
  options.abortSignal?.throwIfAborted();
  const manifestPath = join(options.outputDir, "hayai-regions.json");
  await mkdir(options.outputDir, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    signal: options.abortSignal,
  });
  options.onProgress?.({
    phase: "ocr_running",
    progressText: `일반 텍스트 ${manifest.dialogueRegions.length}개 · 효과음 검토 ${manifest.effectRegions.length}개`,
    detail: "Hayai가 고정된 일반 텍스트 영역만 판독합니다.",
    progressMode: "log-only",
  });
  return { manifest, manifestPath };
}

async function detectHayaiManifest(
  options: TranslationOptions,
  detect: typeof detectPageTextRegions,
): Promise<HayaiRegionManifest> {
  const detection = await detect({
    dataRoot: options.workingDir,
    imagePath: options.imagePath,
    signal: options.abortSignal,
    directMl: {
      graphicsGpuPreference: options.graphicsGpuPreference,
      computeGpuIndex: options.computeGpuIndex,
      computeGpuBackend:
        options.ocrDevice === "gpu" ? options.ocrGpuBackend : undefined,
    },
  });
  return buildHayaiRegionManifest(detection);
}

/** The app already selected this crop. Page detection must not veto it. */
function buildKnownBlockManifest(
  options: TranslationOptions,
): HayaiRegionManifest {
  const { imageWidth: width, imageHeight: height } = options;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  )
    throw new RangeError(
      "Known-block OCR requires exact positive image dimensions.",
    );
  const manifest = buildHayaiRegionManifest({
    imageWidth: width,
    imageHeight: height,
    detections: [],
  });
  manifest.dialogueRegions.push({
    id: 1,
    regionId: "known-block-1",
    kind: "dialogue",
    bbox: [0, 0, width, height],
    // No detector ran. Zero is an unused manifest placeholder, not confidence.
    detectorConfidence: 0,
    sourceDetectionIds: [],
  });
  return manifest;
}
