import type { MangaPage } from "../../shared/libraryTypes";
import type { PageExportRenderSession } from "../pageExport";
import type { PageImageExportDependencies } from "./pageImageExportPorts";
import { buildPagePsd } from "./pagePsdExport";

// Every PSD plane must share the original pixel grid, including transparent
// text. The renderer keeps its source budgets and uses bounded tile capture.
const PSD_CAPTURE_OPTIONS = {
  format: "png",
  resolutionMode: "original",
} as const;

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

type RenderPagePsdOptions = {
  page: MangaPage;
  renderSession: PageExportRenderSession;
  omitText: boolean;
  check: () => void;
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
  const psd = await renderPagePsdExport({
    page,
    renderSession,
    omitText,
    check: () => throwIfAborted(abortController, completedPages, totalPages),
  });
  await (dependencies.runtime.writePsd ?? dependencies.runtime.writePng)(
    outputPath,
    psd,
  );
  throwIfAborted(abortController, completedPages + 1, totalPages);
}

/** One canonical layer capture/assembly for desktop files and managed outputs. */
export async function renderPagePsdExport({
  page,
  renderSession,
  omitText,
  check,
}: RenderPagePsdOptions): Promise<Buffer> {
  const pageWithoutText = { ...page, blocks: [] };
  const compositePng = await renderSession.renderPage(
    omitText ? pageWithoutText : page,
    PSD_CAPTURE_OPTIONS,
  );
  check();
  const originalBackgroundPng = await renderSession.renderPage(
    { ...pageWithoutText, inpaintedImagePath: undefined },
    PSD_CAPTURE_OPTIONS,
  );
  check();
  const cleanedBackgroundPng = page.inpaintedImagePath
    ? await renderSession.renderPage(pageWithoutText, PSD_CAPTURE_OPTIONS)
    : undefined;
  const textLayers = await renderPsdTextLayers({
    page,
    renderSession,
    omitText,
    check,
  });
  const psd = buildPagePsd({
    page,
    compositePng,
    originalBackgroundPng,
    cleanedBackgroundPng,
    textLayers,
  });
  check();
  return psd;
}

async function renderPsdTextLayers({
  omitText,
  page,
  renderSession,
  check,
}: RenderPagePsdOptions): Promise<
  Array<{ block: MangaPage["blocks"][number]; png: Buffer }>
> {
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
    check();
    textLayers.push({
      block,
      png: await renderTransparentPage(
        { ...page, blocks: [block] },
        PSD_CAPTURE_OPTIONS,
      ),
    });
  }
  check();
  return textLayers;
}
