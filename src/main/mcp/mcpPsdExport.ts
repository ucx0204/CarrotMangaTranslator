import type { MangaPage } from "../../shared/libraryTypes";
import type { PageExportRenderSession } from "../pageExport";
import { renderPagePsdExport } from "../jobs/pagePsdExportRunner";
import { McpEditError } from "../application/mcpEditPolicy";

/** Bound the full-page surfaces the native in-memory PSD assembler retains. */
export function assertMcpPsdBudget(page: MangaPage): void {
  const surfaces = page.blocks.length + (page.inpaintedImagePath ? 3 : 2);
  const estimatedBytes = page.width * page.height * 4 * surfaces;
  if (
    !Number.isSafeInteger(page.width) ||
    !Number.isSafeInteger(page.height) ||
    !Number.isSafeInteger(estimatedBytes) ||
    page.width < 1 ||
    page.height < 1 ||
    page.width > 30000 ||
    page.height > 30000 ||
    page.blocks.length > 200 ||
    estimatedBytes > 256 * 1024 * 1024
  )
    throw new McpEditError(
      "invalid_edit",
      "PSD exceeds the 200-block, 30,000-pixel side or 256-MiB decoded-layer admission budget. No downscaling or flattened substitute is performed.",
    );
}

/** The desktop writer decides editable text versus faithfully rasterized layers. */
export function renderMcpPsdInSession(
  page: MangaPage,
  session: PageExportRenderSession,
  signal?: AbortSignal,
) {
  assertMcpPsdBudget(page);
  const capture = { format: "png", resolutionMode: "original" } as const;
  const transparent = session.renderTransparentPage;
  return renderPagePsdExport({
    page,
    omitText: false,
    check: () => signal?.throwIfAborted(),
    renderSession: {
      renderPage: (layer) => session.renderPage(layer, capture),
      ...(transparent
        ? {
            renderTransparentPage: (layer: MangaPage) =>
              transparent(layer, capture),
          }
        : {}),
      close: () => session.close(),
    },
  });
}
