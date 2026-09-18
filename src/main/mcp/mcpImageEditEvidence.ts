import { createHash } from "node:crypto";
import type { MangaPage } from "../../shared/libraryTypes";
import { createPageRevision } from "../../shared/pageRevision";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  MAX_MCP_IMAGE_EDIT_PIXELS,
  type McpImageEditCommand,
} from "../../shared/mcpImageEditing";
import type { McpImageFileEvidence } from "../application/mcpImageEditPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import { openChapter } from "../library";
import { probePageExportSourceImage } from "../pageExportRasterSafety";
import { loadPageImage } from "../inpainting/imageIO";
import { hashMcpOriginalImage } from "./mcpTypographySourceEvidence";
import { buildMcpImageEditMasks } from "./mcpImageEditMasks";

export async function readMcpImageEditPage(
  target: { chapterId: string; pageId: string; revision: string },
  guard: () => void,
) {
  guard();
  const chapter = await openChapter(target.chapterId);
  guard();
  const page = chapter.pages.find((page) => page.id === target.pageId);
  if (!page || chapter.id !== target.chapterId)
    throw new McpEditError("not_found", "Image edit page is missing.");
  if (createPageRevision(page) !== target.revision)
    throw new McpEditError(
      "revision_conflict",
      "Image edit page changed; prepare a new plan.",
    );
  if (page.analysisStatus === "running")
    throw new McpEditError("editor_busy", "The page has active processing.");
  return page;
}
export async function captureMcpImageFiles(page: MangaPage, guard: () => void) {
  if (
    !Number.isSafeInteger(page.width) ||
    !Number.isSafeInteger(page.height) ||
    page.width < 1 ||
    page.height < 1 ||
    page.width * page.height > MAX_MCP_IMAGE_EDIT_PIXELS
  )
    throw new McpEditError(
      "invalid_edit",
      "Image editing supports at most 16 million original pixels per page.",
    );
  const paths = [
    ...new Set([page.imagePath, page.inpaintedImagePath, page.inpaintMaskPath]),
  ].filter((path): path is string => Boolean(path));
  const files: McpImageFileEvidence[] = [];
  for (const path of paths) {
    guard();
    const size = await probePageExportSourceImage(path);
    if (size.width !== page.width || size.height !== page.height)
      throw new McpEditError(
        "revision_conflict",
        "An image or mask no longer matches page dimensions.",
      );
    files.push({ path, sha256: await hashMcpOriginalImage(path, guard) });
  }
  guard();
  return files;
}
export async function verifyMcpImageFiles(
  files: McpImageFileEvidence[],
  guard: () => void,
) {
  for (const file of files)
    if ((await hashMcpOriginalImage(file.path, guard)) !== file.sha256)
      throw new McpEditError(
        "revision_conflict",
        "An image or recovery artifact changed; nothing was overwritten.",
      );
  guard();
}
export async function prepareMcpImageEdit(
  page: MangaPage,
  command: McpImageEditCommand,
  guard: () => void,
  signal?: AbortSignal,
) {
  const files = await captureMcpImageFiles(page, guard);
  const source = await loadPageImage(page.imagePath);
  const size = source.getSize();
  if (size.width !== page.width || size.height !== page.height)
    throw new McpEditError(
      "revision_conflict",
      "Decoded original dimensions changed.",
    );
  guard();
  const prepared = buildMcpImageEditMasks(
    page,
    command,
    Buffer.from(source.toBitmap()),
    signal,
  );
  await verifyMcpImageFiles(files, guard);
  const digest = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");
  const mask = {
    ...prepared.stats,
    snapshot: hashStableValue([
      files,
      command,
      digest(prepared.mask),
      digest(prepared.protectedMask),
    ]),
  };
  return { ...prepared, evidence: { files, mask } };
}
