import { nativeImage } from "electron";
import { PNG } from "pngjs";
import type { MangaPage } from "../../shared/libraryTypes";
import type { McpExternalImagePreview } from "../../shared/mcpExternalImages";
import { restoreHiddenPixels } from "../imageRedactionPixels";
import { loadPageImage } from "../inpainting/imageIO";
import { McpEditError } from "../application/mcpEditPolicy";
import { decodeMcpUploadPng } from "./mcpImageUploadPng";
import type { ExternalImageAssets } from "./mcpExternalImageAssets";

type Command = McpExternalImagePreview["command"];
/** No model or image sizing heuristic. External pixels use exact declared placement. */
export async function composeMcpExternalImage(
  page: MangaPage,
  command: Command,
  assets: ExternalImageAssets,
) {
  const image = decodeMcpUploadPng(assets.image, {
    ...assets,
    purpose: "image",
  }).png;
  const mask = effectiveMask(assets);
  if (command.kind === "lettering") {
    for (let i = 0; i < mask.selected.length; i++)
      if (!mask.selected[i]) image.data.fill(0, i * 4, i * 4 + 4);
    const bytes = PNG.sync.write(image);
    if (bytes.length > 2 * 1024 * 1024)
      throw new McpEditError(
        "invalid_edit",
        "Lettering PNG exceeds the 2 MiB per-layer limit; no resizing was performed.",
      );
    return {
      bytes,
      mask: mask.selected,
      width: assets.width,
      height: assets.height,
      selectedPixels: count(mask.selected),
      protectedPixels: count(mask.protected),
      changedPixels: 0,
    };
  }
  const rect =
    command.kind === "patch-background"
      ? command.rect
      : { x: 0, y: 0, w: page.width, h: page.height };
  if (
    rect.w !== assets.width ||
    rect.h !== assets.height ||
    rect.x + rect.w > page.width ||
    rect.y + rect.h > page.height
  )
    throw new McpEditError(
      "invalid_edit",
      "Patch dimensions must exactly match an in-page original-pixel rectangle; no stretching or clipping is performed.",
    );
  const base = await loadPageImage(page.inpaintedImagePath ?? page.imagePath);
  const before = Buffer.from(base.toBitmap()),
    after = Buffer.from(before);
  const incoming = nativeImage.createFromBuffer(assets.image);
  if (incoming.isEmpty() || before.length !== page.width * page.height * 4)
    throw new McpEditError(
      "invalid_edit",
      "Native image dimensions do not match the reviewed page.",
    );
  const pixels = incoming.toBitmap(),
    pageMask = new Uint8Array(page.width * page.height);
  const hidden = new Uint8Array(pageMask.length).fill(1);
  let changedPixels = 0;
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const source = y * rect.w + x,
        target = (y + rect.y) * page.width + x + rect.x;
      if (!mask.selected[source]) continue;
      if (image.data[source * 4 + 3] !== 255)
        throw new McpEditError(
          "invalid_edit",
          "Selected background pixels must be opaque. Transparent lettering belongs in a lettering layer.",
        );
      pageMask[target] = 1;
      hidden[target] = 0;
      const value = pixels.subarray(source * 4, source * 4 + 4);
      if (!before.subarray(target * 4, target * 4 + 4).equals(value))
        changedPixels++;
      value.copy(after, target * 4);
    }
  }
  restoreHiddenPixels(before, after, hidden);
  assets.guard();
  return {
    bytes: nativeImage
      .createFromBitmap(after, { width: page.width, height: page.height })
      .toPNG(),
    mask: pageMask,
    width: page.width,
    height: page.height,
    selectedPixels: count(mask.selected),
    protectedPixels: count(mask.protected),
    changedPixels,
  };
}
function effectiveMask(assets: ExternalImageAssets) {
  const declared = {
    width: assets.width,
    height: assets.height,
    purpose: "mask" as const,
  };
  const selected = new Uint8Array(assets.width * assets.height).fill(1);
  const protectedMask = new Uint8Array(selected.length);
  if (assets.mask) {
    const png = decodeMcpUploadPng(assets.mask, declared).png;
    for (let i = 0; i < selected.length; i++)
      selected[i] = png.data[i * 4] ? 1 : 0;
  }
  if (assets.protectedMask) {
    const png = decodeMcpUploadPng(assets.protectedMask, declared).png;
    for (let i = 0; i < selected.length; i++) {
      protectedMask[i] = png.data[i * 4] ? 1 : 0;
      if (protectedMask[i]) selected[i] = 0;
    }
  }
  return { selected, protected: protectedMask };
}
function count(mask: Uint8Array) {
  return mask.reduce((total, value) => total + value, 0);
}
