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
): Promise<{
  manifest: HayaiRegionManifest;
  manifestPath: string;
}> {
  if (!isHayaiOcrPipeline(options.ocrPipeline)) {
    throw new Error("HayaiOCR 영역 전처리는 최신 OCR 경로에서만 실행됩니다.");
  }
  options.onProgress?.({
    phase: "ocr_preparing",
    progressText: "HayaiOCR 텍스트 영역 준비 중",
    detail: "일반 텍스트와 검토 대상 효과음을 서로 다른 영역으로 검출합니다.",
    progressMode: "indeterminate",
  });
  const detection = await detectPageTextRegions({
    dataRoot: options.workingDir,
    imagePath: options.imagePath,
    signal: options.abortSignal,
  });
  const manifest = buildHayaiRegionManifest(detection);
  const manifestPath = join(options.outputDir, "hayai-regions.json");
  await mkdir(options.outputDir, { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  options.onProgress?.({
    phase: "ocr_running",
    progressText: `일반 텍스트 ${manifest.dialogueRegions.length}개 · 효과음 검토 ${manifest.effectRegions.length}개`,
    detail: "Hayai가 고정된 일반 텍스트 영역만 판독합니다.",
    progressMode: "log-only",
  });
  return { manifest, manifestPath };
}
