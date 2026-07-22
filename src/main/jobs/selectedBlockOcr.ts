import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import type { JobEvent } from "../../shared/jobTypes";
import type { TranslationOptions } from "../appSettings";
import type { ChapterRunPaths } from "../library";
import type { ImageDecodeFallback } from "../regionCrop";
import { prepareKeepBlockHints } from "../pipeline/keepBlocksOcr";
import { prepareAnalysisRun } from "../pipeline/prepareAnalysisRun";
import { tMain } from "./localization";

export function resolveSelectedBlock(
  page: MangaPage,
  blockId?: string,
): TranslationBlock | undefined {
  if (!blockId) return undefined;
  const block = page.blocks.find((candidate) => candidate.id === blockId);
  if (!block) throw new Error(tMain("region.blockNotFound"));
  return block;
}

function resolveSelectedBlockOcrMode(
  options: Pick<TranslationOptions, "ocrQualityMode" | "ocrGpuBackend">,
): "vl" | "ocr" {
  return options.ocrQualityMode === "full" &&
    options.ocrGpuBackend !== "rocm-transformers"
    ? "vl"
    : "ocr";
}

export async function recognizeSelectedBlock({
  decodeImage,
  emit,
  jobId,
  page,
  runPaths,
  signal,
}: {
  decodeImage: ImageDecodeFallback;
  emit: (event: JobEvent) => void;
  jobId: string;
  page: MangaPage;
  runPaths: ChapterRunPaths;
  signal: AbortSignal;
}): Promise<{ pages: MangaPage[]; warnings: string[] }> {
  const run = await prepareAnalysisRun({
    jobId,
    emit,
    pages: [page],
    runPaths,
    signal,
    skipOcrPrepass: false,
  });
  const hintsByPageId = await prepareKeepBlockHints({
    runtime: run.runtime,
    baseOptions: {
      ...run.baseOptions,
      ocrBboxMode: resolveSelectedBlockOcrMode(run.baseOptions),
    },
    keepPages: [page],
    pageCount: 1,
    runPaths,
    emit,
    jobId,
    signal,
    decodeImage,
  });
  const sourceText = readFirstOcrText(hintsByPageId.get(page.id)?.hints);
  const block = page.blocks[0];
  if (!block || !sourceText) {
    throw new Error(tMain("region.blockResultMissing"));
  }
  return {
    pages: [
      {
        ...page,
        blocks: [{ ...block, sourceText, reviewStatus: "draft" }],
      },
    ],
    warnings: [],
  };
}

function readFirstOcrText(hints: unknown[] | undefined): string {
  const first = hints?.[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return "";
  return String((first as Record<string, unknown>).ocrText ?? "").trim();
}
