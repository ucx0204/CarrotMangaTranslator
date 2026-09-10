import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  redactionPreviewRequestSchema,
  type RedactionPreviewRequest,
} from "../shared/imageRedactionWorkspace";
import { getRedactionWorkspacePage } from "./imageRedactionWorkspaceSessions";
import { loadPageImageSnapshot } from "./inpainting/imageIO";
import type { ImageDecodeFallback } from "./regionCrop";

const previews = new Map<string, string>();
const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;
let previewBytes = 0;

export async function getRedactionWorkspacePreview(
  input: RedactionPreviewRequest,
  decodeImage: ImageDecodeFallback,
): Promise<string> {
  const request = redactionPreviewRequestSchema.parse(input);
  const { page, signal } = getRedactionWorkspacePage(
    request.sessionId,
    request.pageId,
  );
  signal.throwIfAborted();
  const bytes = await readFile(page.imagePath);
  signal.throwIfAborted();
  if (createHash("sha256").update(bytes).digest("hex") !== page.fingerprint)
    throw new Error(
      "원본 이미지가 변경되었습니다. 해당 페이지를 다시 준비해 주세요.",
    );
  const key = `${page.imagePath}\0${page.fingerprint}\0${request.maxEdge}`;
  const cached = previews.get(key);
  if (cached) {
    previews.delete(key);
    previews.set(key, cached);
    return cached;
  }
  const image = await loadPageImageSnapshot(
    page.imagePath,
    bytes,
    (path) => decodeImage(path, signal),
    signal,
  );
  signal.throwIfAborted();
  const size = image.getSize();
  if (size.width !== page.width || size.height !== page.height)
    throw new Error("원본 이미지 크기가 변경되었습니다.");
  const scale = Math.min(
    1,
    request.maxEdge / Math.max(size.width, size.height),
  );
  const preview =
    scale < 1
      ? image.resize({
          width: Math.max(1, Math.round(size.width * scale)),
          height: Math.max(1, Math.round(size.height * scale)),
          quality: "good",
        })
      : image;
  const url = preview.toDataURL();
  getRedactionWorkspacePage(request.sessionId, request.pageId);
  cachePreview(key, url);
  return url;
}

function cachePreview(key: string, url: string): void {
  if (url.length > MAX_PREVIEW_BYTES) return;
  while (previews.size >= 64 || previewBytes + url.length > MAX_PREVIEW_BYTES) {
    const first = previews.keys().next().value;
    if (first === undefined) break;
    previewBytes -= previews.get(first)?.length ?? 0;
    previews.delete(first);
  }
  previewBytes -= previews.get(key)?.length ?? 0;
  previews.set(key, url);
  previewBytes += url.length;
}
