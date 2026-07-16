import type { MangaPage } from "../../shared/libraryTypes";
import { prepareKeepBlockHints } from "./keepBlocksOcr";
import {
  buildKeepBlocksOcrResult,
  shouldKeepExistingBlocks,
} from "./keepBlocksResult";
import { prepareOcrHintsForPages } from "./ocrHints";
import { prepareAnalysisRun } from "./prepareAnalysisRun";
import { prepareRegionContextOcrHints } from "./regionOcrContext";
import { logPipelineInfo } from "./translationAttemptLogging";
import type { OcrBboxResult, PipelineOptions } from "./types";

export async function preparePageOcrHints({
  jobId,
  pages,
  run,
  runPaths,
  signal,
  skipOcrPrepass,
  blockMode,
  decodeImage,
  regionContext,
}: {
  jobId: string;
  pages: MangaPage[];
  run: Awaited<ReturnType<typeof prepareAnalysisRun>>;
  runPaths: PipelineOptions["runPaths"];
  signal: AbortSignal;
  skipOcrPrepass: boolean;
  blockMode?: PipelineOptions["blockMode"];
  decodeImage?: PipelineOptions["decodeImage"];
  regionContext?: PipelineOptions["regionContext"];
}): Promise<Map<string, OcrBboxResult>> {
  if (regionContext) {
    return prepareRegionContextOcrHints({
      runtime: run.runtime,
      baseOptions: run.baseOptions,
      emit: run.progressContext.emit,
      jobId,
      pages,
      regionContext,
      runPaths,
      signal,
    });
  }
  if (skipOcrPrepass) {
    logPipelineInfo("OCR prepass skipped for analysis pipeline", {
      jobId,
      pageCount: pages.length,
    });
    return new Map<string, OcrBboxResult>(
      pages
        .filter((page) => shouldKeepExistingBlocks(blockMode, page))
        .map((page) => [page.id, buildKeepBlocksOcrResult(page)]),
    );
  }
  const keepBlockHints = await prepareKeepBlockHints({
    runtime: run.runtime,
    baseOptions: run.baseOptions,
    keepPages: pages.filter((page) =>
      shouldKeepExistingBlocks(blockMode, page),
    ),
    pageCount: pages.length,
    runPaths,
    emit: run.progressContext.emit,
    jobId,
    signal,
    decodeImage,
  });
  const prepassPages = pages.filter((page) => !keepBlockHints.has(page.id));
  if (prepassPages.length === 0) {
    return keepBlockHints;
  }
  const prepassHints = await prepareOcrHintsForPages({
    runtime: run.runtime,
    baseOptions: run.baseOptions,
    pages: prepassPages,
    runPaths,
    emit: run.progressContext.emit,
    jobId,
    signal,
  });
  return new Map([...keepBlockHints, ...prepassHints]);
}
