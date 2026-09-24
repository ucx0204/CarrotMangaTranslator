import type { MangaPage } from "../../shared/libraryTypes";
import {
  prepareExternalImageFile,
  requireImageRedactionReview,
} from "../imageRedactionContext";
import { loadPageImage } from "../inpainting/imageIO";

const MAX_EDGE = 1600;
const MAX_PNG_BYTES = 4 * 1024 * 1024;

/** Never reads page.dataUrl or a path supplied by the remote caller. */
export async function renderMcpPagePreview(page: MangaPage) {
  if (page.width * page.height > 64_000_000) {
    throw new Error("Source image is too large for an MCP preview.");
  }
  // This fails closed if the app requires review and no approved context exists.
  // Do not fabricate an approved context to make an external preview succeed.
  const path = await prepareExternalImageFile(page.imagePath);
  const image = await loadPageImage(path);
  const size = image.getSize();
  if (size.width !== page.width || size.height !== page.height) {
    throw new Error("Source image dimensions changed; reload the chapter.");
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(size.width, size.height));
  const preview = image.resize({
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
    quality: "best",
  });
  const png = preview.toPNG();
  if (png.length > MAX_PNG_BYTES) {
    throw new Error("Preview exceeds the MCP image transfer limit.");
  }
  const { width, height } = preview.getSize();
  await requireImageRedactionReview();
  return { data: png.toString("base64"), width, height };
}
