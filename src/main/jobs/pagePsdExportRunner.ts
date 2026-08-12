import type { MangaPage } from "../../shared/libraryTypes";
import type { PageExportRenderSession } from "../pageExport";
import type { PageImageExportDependencies } from "./pageImageExportPorts";
import { buildPagePsd } from "./pagePsdExport";

type AbortGuard = (
  abortController: AbortController,
  completedPages: number,
  totalPages: number,
) => void;

type WritePagePsdExportOptions = {
  abortController: AbortController;
  completedPages: number;
  dependencies: PageImageExportDependencies;
  omitText: boolean;
  outputPath: string;
  page: MangaPage;
  renderSession: PageExportRenderSession;
  throwIfAborted: AbortGuard;
  totalPages: number;
};

export async function writePagePsdExport({
  abortController,
  completedPages,
  dependencies,
  omitText,
  outputPath,
  page,
  renderSession,
  throwIfAborted,
  totalPages,
}: WritePagePsdExportOptions): Promise<void> {
  const pageWithoutText = { ...page, blocks: [] };
  const compositePng = await renderSession.renderPage(
    omitText ? pageWithoutText : page,
  );
  throwIfAborted(abortController, completedPages, totalPages);
  const originalBackgroundPng = await renderSession.renderPage({
    ...pageWithoutText,
    inpaintedImagePath: undefined,
  });
  throwIfAborted(abortController, completedPages, totalPages);
  const cleanedBackgroundPng = page.inpaintedImagePath
    ? await renderSession.renderPage(pageWithoutText)
    : undefined;
  const textLayers = await renderPsdTextLayers({
    abortController,
    completedPages,
    omitText,
    page,
    renderSession,
    throwIfAborted,
    totalPages,
  });
  const psd = buildPagePsd({
    page,
    compositePng,
    originalBackgroundPng,
    cleanedBackgroundPng,
    textLayers,
  });
  throwIfAborted(abortController, completedPages, totalPages);
  await (dependencies.runtime.writePsd ?? dependencies.runtime.writePng)(
    outputPath,
    psd,
  );
  throwIfAborted(abortController, completedPages + 1, totalPages);
}

async function renderPsdTextLayers({
  abortController,
  completedPages,
  omitText,
  page,
  renderSession,
  throwIfAborted,
  totalPages,
}: Pick<
  WritePagePsdExportOptions,
  | "abortController"
  | "completedPages"
  | "omitText"
  | "page"
  | "renderSession"
  | "throwIfAborted"
  | "totalPages"
>): Promise<Array<{ block: MangaPage["blocks"][number]; png: Buffer }>> {
  if (omitText) return [];
  const renderTransparentPage = renderSession.renderTransparentPage;
  if (!renderTransparentPage) {
    throw new Error("PSD text-layer renderer is unavailable.");
  }
  const textLayers: Array<{
    block: MangaPage["blocks"][number];
    png: Buffer;
  }> = [];
  for (const block of page.blocks) {
    throwIfAborted(abortController, completedPages, totalPages);
    textLayers.push({
      block,
      png: await renderTransparentPage({ ...page, blocks: [block] }),
    });
  }
  throwIfAborted(abortController, completedPages, totalPages);
  return textLayers;
}
