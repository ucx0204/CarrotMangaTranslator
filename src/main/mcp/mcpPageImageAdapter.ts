import { nativeImage } from "electron";
import type { MangaPage } from "../../shared/libraryTypes";
import type { PixelRect } from "../../shared/region";
import { prepareExternalImageFile } from "../imageRedactionContext";
import { readImageRedactionState } from "../imageRedactionStore";
import { loadPageImage } from "../inpainting/imageIO";
import { createPageExportRenderSession } from "../pageExport";
import { getAppPaths } from "../appPaths";
import { probePageExportSourceImage } from "../pageExportRasterSafety";
import { McpEditError } from "../application/mcpEditPolicy";

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
  return reduced(
    image.crop({ x: rect.x, y: rect.y, width: rect.w, height: rect.h }),
  );
}

/** Derived images may contain unredacted overlays. Until derived-layer review is
 * supported, reject them whenever redaction is enabled rather than masking only the base. */
export async function renderMcpSavedPage(page: MangaPage) {
  const bytes = await renderMcpPagePng(page, undefined, 25_000);
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error("App renderer returned an invalid PNG.");
  return reduced(image);
}
export async function renderMcpPagePng(
  page: MangaPage,
  signal?: AbortSignal,
  timeoutMs = 120_000,
) {
  if ((await readImageRedactionState()).enabled)
    throw new McpEditError(
      "access_denied",
      "Rendered image transfer is blocked while redaction review is enabled. Derived-layer review is not implemented yet.",
    );
  const path = await prepareExternalImageFile(
    page.inpaintedImagePath ?? page.imagePath,
  );
  await assertSize(path, page);
  signal?.throwIfAborted();
  const session = await createPageExportRenderSession({
    dataRoot: getAppPaths().dataRoot,
    decodeFallback: async () => null,
    lowPriority: true,
  });
  const cancel = () => session.cancel?.();
  const timeout = setTimeout(cancel, timeoutMs);
  timeout.unref();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    // Pin the selected raster: never fall back from missing inpainting to the original.
    return await session.renderPage(
      { ...page, imagePath: path, inpaintedImagePath: path },
      { format: "png", resolutionMode: "original" },
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
    session.close();
  }
}
async function assertSize(path: string, page: MangaPage) {
  const size = await probePageExportSourceImage(path);
  if (size.width !== page.width || size.height !== page.height)
    throw new McpEditError(
      "revision_conflict",
      "Image dimensions changed. Reload the chapter.",
    );
}
