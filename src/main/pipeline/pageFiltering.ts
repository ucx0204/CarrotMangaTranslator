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
  options: { allowNoTextSkip?: boolean } = {},
): FilteredPages {
  // OCR "텍스트 없음" 프리패스 스킵은 일본어 원문 전용 최적화다. 다른 원문
  // 언어에서는 OCR false negative가 페이지를 통째로 비워버리므로 항상 모델
  // 호출 대상에 포함한다.
  const allowNoTextSkip = options.allowNoTextSkip ?? true;
  const pageIndexById = new Map(pages.map((page, index) => [page.id, index]));
  const completedPagesById = new Map<string, MangaPage>();
  const pagesToTranslate: MangaPage[] = [];
  const prepassNoTextPages: Array<{ page: MangaPage; pageIndex: number }> = [];

  for (const page of pages) {
    const ocrResult = ocrHintsByPageId.get(page.id);
    if (!allowNoTextSkip || !isOcrResultNoTextDetected(ocrResult)) {
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
