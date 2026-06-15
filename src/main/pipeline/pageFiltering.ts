import type { MangaPage } from "../../shared/types";
import { buildNoTextCompletedPage, isOcrResultNoTextDetected } from "./noText";
import { emitNoTextPage, type ProgressContext } from "./progressEvents";
import type { OcrBboxResult, PipelineOptions } from "./types";

export type FilteredPages = {
  pageIndexById: Map<string, number>;
  completedPagesById: Map<string, MangaPage>;
  pagesToTranslate: MangaPage[];
  prepassNoTextPages: Array<{ page: MangaPage; pageIndex: number }>;
};

export function filterPagesByOcrText(
  pages: MangaPage[],
  ocrHintsByPageId: Map<string, OcrBboxResult>,
): FilteredPages {
  const pageIndexById = new Map(pages.map((page, index) => [page.id, index]));
  const completedPagesById = new Map<string, MangaPage>();
  const pagesToTranslate: MangaPage[] = [];
  const prepassNoTextPages: Array<{ page: MangaPage; pageIndex: number }> = [];

  for (const page of pages) {
    const ocrResult = ocrHintsByPageId.get(page.id);
    if (!isOcrResultNoTextDetected(ocrResult)) {
      pagesToTranslate.push(page);
      continue;
    }

    const pageIndex = pageIndexById.get(page.id) ?? 0;
    const noTextPage = buildNoTextCompletedPage(page);
    completedPagesById.set(page.id, noTextPage);
    prepassNoTextPages.push({ page: noTextPage, pageIndex });
  }

  return {
    pageIndexById,
    completedPagesById,
    pagesToTranslate,
    prepassNoTextPages,
  };
}

export async function completePrepassNoTextPages({
  context,
  onPageComplete,
  onPagesComplete,
  prepassNoTextPages,
}: {
  context: ProgressContext;
  onPageComplete?: PipelineOptions["onPageComplete"];
  onPagesComplete?: PipelineOptions["onPagesComplete"];
  prepassNoTextPages: FilteredPages["prepassNoTextPages"];
}): Promise<void> {
  if (prepassNoTextPages.length === 0) {
    return;
  }

  if (onPagesComplete) {
    await onPagesComplete(prepassNoTextPages.map((entry) => entry.page));
  } else {
    for (const entry of prepassNoTextPages) {
      await onPageComplete?.(entry.page);
    }
  }
  for (const entry of prepassNoTextPages) {
    emitNoTextPage(context, entry.page, entry.pageIndex);
  }
}

export function buildPipelinePages(
  pages: MangaPage[],
  completedPagesById: Map<string, MangaPage>,
): MangaPage[] {
  return pages.map((page) => completedPagesById.get(page.id) ?? page);
}
