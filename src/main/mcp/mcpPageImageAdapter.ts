import { nativeImage } from "electron";
import type { MangaPage } from "../../shared/libraryTypes";
import type { PixelRect } from "../../shared/region";
import {
  McpPageExportOptionsSchema,
  type McpPageExportOptions,
} from "../../shared/mcpOutputFormats";
import {
  prepareExternalImageFile,
  requireImageRedactionReview,
} from "../imageRedactionContext";
import { readImageRedactionState } from "../imageRedactionStore";
import { loadPageImage } from "../inpainting/imageIO";
import { createPageExportRenderSession } from "../pageExport";
import { getAppPaths } from "../appPaths";
import { probePageExportSourceImage } from "../pageExportRasterSafety";
import { McpEditError } from "../application/mcpEditPolicy";
import { assertMcpPsdBudget, renderMcpPsdInSession } from "./mcpPsdExport";

function reduced(image: Electron.NativeImage) {
  const size = image.getSize();
  const scale = Math.min(1, 1600 / Math.max(size.width, size.height));
  const preview = image.resize({
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
    quality: "best",
  });
  const bytes = preview.toPNG();
  if (bytes.length > 4 * 1024 * 1024)
    throw new Error("MCP preview exceeds 4 MiB. Request a smaller crop.");
  return { data: bytes.toString("base64"), ...preview.getSize() };
}

export async function cropMcpPage(page: MangaPage, rect: PixelRect) {
  const path = await prepareExternalImageFile(page.imagePath);
  await assertSize(path, page);
  const image = await loadPageImage(path);
  const result = reduced(
    image.crop({ x: rect.x, y: rect.y, width: rect.w, height: rect.h }),
  );
  await requireImageRedactionReview();
  return result;
}

/** Derived images remain blocked while redaction review is enabled. */
export async function renderMcpSavedPage(page: MangaPage) {
  const bytes = await renderMcpPagePng(page, undefined, 25_000);
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error("App renderer returned an invalid PNG.");
  return reduced(image);
}
export function renderMcpPagePng(
  page: MangaPage,
  signal?: AbortSignal,
  timeoutMs = 120_000,
  openRenderer = createPageExportRenderSession,
) {
  return renderMcpPageImage(
    page,
    signal,
    { format: "png", omitText: false },
    timeoutMs,
    openRenderer,
  );
}
export async function renderMcpPageImage(
  page: MangaPage,
  signal: AbortSignal | undefined,
  input: McpPageExportOptions,
  timeoutMs = 120_000,
  openRenderer = createPageExportRenderSession,
) {
  const options = McpPageExportOptionsSchema.parse(input);
  await assertDerivedImageAccess();
  const prepared = await prepareOutputPage(page, options);
  signal?.throwIfAborted();
  const session = await openRenderer({
    dataRoot: getAppPaths().dataRoot,
    decodeFallback: async () => null,
    lowPriority: true,
  });
  const lifetime = new AbortController();
  const stop = (reason: unknown) => {
    if (lifetime.signal.aborted) return;
    lifetime.abort(reason);
    session.cancel?.();
  };
  const cancel = () => stop(signal?.reason);
  const timeout = setTimeout(
    () => stop(new Error("MCP page output timed out.")),
    timeoutMs,
  );
  timeout.unref();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const bytes =
      options.format === "psd"
        ? await renderMcpPsdInSession(prepared, session, lifetime.signal)
        : await session.renderPage(prepared, {
            format: options.format,
            ...(options.quality === undefined
              ? {}
              : { quality: options.quality }),
            resolutionMode: "original",
          });
    lifetime.signal.throwIfAborted();
    await assertDerivedImageAccess();
    lifetime.signal.throwIfAborted();
    return bytes;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
    session.close();
  }
}

async function prepareOutputPage(
  page: MangaPage,
  options: McpPageExportOptions,
) {
  assertTextlessReady(page, options.omitText);
  if (options.format === "psd") assertMcpPsdBudget(page);
  const path = await prepareExternalImageFile(
    page.inpaintedImagePath ?? page.imagePath,
  );
  await assertSize(path, page);
  if (options.format === "psd") {
    const original = await prepareExternalImageFile(page.imagePath);
    await assertSize(original, page);
    return {
      ...page,
      imagePath: original,
      inpaintedImagePath: page.inpaintedImagePath ? path : undefined,
    };
  }
  return {
    ...page,
    imagePath: path,
    inpaintedImagePath: path,
    ...(options.omitText ? { blocks: [] } : {}),
  };
}
function assertTextlessReady(page: MangaPage, omitText: boolean): void {
  if (omitText && !page.inpaintedImagePath)
    throw new McpEditError(
      "invalid_edit",
      "Textless output needs an existing inpainted image; no automatic erasure or original fallback.",
    );
}

async function assertSize(path: string, page: MangaPage) {
  const size = await probePageExportSourceImage(path);
  if (size.width !== page.width || size.height !== page.height)
    throw new McpEditError(
      "revision_conflict",
      "Image dimensions changed. Reload the chapter.",
    );
}

async function assertDerivedImageAccess(): Promise<void> {
  if ((await readImageRedactionState()).enabled)
    throw new McpEditError(
      "access_denied",
      "Rendered image transfer is blocked while redaction review is enabled. Derived-layer review is not implemented yet.",
    );
}
