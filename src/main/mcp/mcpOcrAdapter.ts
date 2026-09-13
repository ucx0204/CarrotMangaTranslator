import type { MangaPage } from "../../shared/libraryTypes";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { JobEvent } from "../../shared/jobTypes";
import { getRunPaths } from "../library";
import { getAppSettings } from "../settingsStore";
import { buildBaseOptions } from "../pipeline/options";
import { prepareOcrHintsForPages } from "../pipeline/ocrHints";
import {
  loadTranslationRuntimePort,
  disposeTranslationRuntimeResources,
} from "../translationRuntime";
import type { McpOperationContext } from "../application/mcpOperationService";
import { mcpOcrReadingBlocks } from "../application/mcpOcrReadingPolicy";

export async function recognizeMcpPage(
  app: InpaintingJobContext,
  chapterId: string,
  page: MangaPage,
  operation: McpOperationContext,
  emit: (event: JobEvent) => void,
) {
  const settings = await getAppSettings(app.appPaths);
  const runPaths = await getRunPaths(chapterId, operation.id);
  const baseOptions = buildBaseOptions(
    operation.id,
    runPaths.runDir,
    settings,
    app.appPaths,
  );
  operation.assertAuthorized();
  const runtime = loadTranslationRuntimePort();
  try {
    const results = await prepareOcrHintsForPages({
      runtime,
      baseOptions,
      pages: [page],
      runPaths,
      jobId: operation.id,
      signal: operation.signal,
      emit,
    });
    operation.assertAuthorized();
    const result = results.get(page.id);
    if (!result) throw new Error("OCR returned no page result.");
    return {
      blocks: mcpOcrReadingBlocks(page, result.hints),
      engine: baseOptions.ocrPipeline ?? "paddleocr",
      noTextDetected: result.noTextDetected === true,
      effectReviewCandidates: result.effectReviewRegions?.length ?? 0,
    };
  } finally {
    await disposeTranslationRuntimeResources("mcp-ocr-finished");
  }
}
