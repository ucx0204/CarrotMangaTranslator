import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { nativeImage } from "electron";
import type { MangaPage } from "../../shared/libraryTypes";
import { McpEditError } from "../application/mcpEditPolicy";
import { loadPageImage, resolveInpaintedImagePath } from "../inpainting/imageIO";
import { persistRetouchDifferenceMask } from "../inpainting/inpaintMaskArtifact";
import { removeArtifactAfterFailure } from "../artifactCleanup";
import { discardMcpImageProduct } from "./mcpImageEditPersistence";

/** Staging only. The native image transaction owns publication and history. */
export async function stageMcpExternalBackground(
  page: MangaPage,
  bytes: Buffer,
  guard: () => void,
): Promise<MangaPage> {
  guard();
  const original = await loadPageImage(page.imagePath);
  const output = nativeImage.createFromBuffer(bytes);
  for (const image of [original, output]) {
    const size = image.getSize();
    if (image.isEmpty() || size.width !== page.width || size.height !== page.height)
      throw new McpEditError("revision_conflict", "External background dimensions changed before staging.");
  }
  guard();
  const path = resolveInpaintedImagePath(page.imagePath, "external");
  await writeNewImage(path, bytes);
  let next: MangaPage = { ...page, inpaintedImagePath: path };
  try {
    guard();
    const mask = await persistRetouchDifferenceMask({
      page,
      originalBitmap: Buffer.from(original.toBitmap()),
      outputBitmap: Buffer.from(output.toBitmap()),
      width: page.width,
      height: page.height,
    });
    next = {
      ...next,
      inpaintMaskPath: mask.path,
      maskProvenance: mask.provenance,
      ...(page.translationCompletion ? {
        translationCompletion: { workflow: page.translationCompletion.workflow, status: "pending" as const },
      } : {}),
      updatedAt: new Date().toISOString(),
    };
    guard();
    return next;
  } catch (error) {
    return discardMcpImageProduct(page, next, error);
  }
}

async function writeNewImage(path: string, bytes: Buffer) {
  await mkdir(dirname(path), { recursive: true });
  // Only a successfully opened exclusive file belongs to this request's cleanup.
  const handle = await open(path, "wx", 0o600);
  let failure: unknown;
  try {
    await handle.writeFile(bytes);
  } catch (error) {
    failure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    failure = failure
      ? new AggregateError([failure, error], "External image write and close failed.", { cause: error })
      : error;
  }
  if (failure) return removeArtifactAfterFailure(path, failure);
}
