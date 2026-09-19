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
  return command.kind === "lettering"
    ? composeLettering(image, assets, mask)
    : composeBackground(page, command, assets, mask, image.data);
}
function composeLettering(
  image: ReturnType<typeof decodeMcpUploadPng>["png"],
  assets: ExternalImageAssets,
  mask: ReturnType<typeof effectiveMask>,
) {
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
async function composeBackground(
  page: MangaPage,
  command: Exclude<Command, { kind: "lettering" }>,
  assets: ExternalImageAssets,
  mask: ReturnType<typeof effectiveMask>,
  imageData: Buffer,
) {
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
  const size = incoming.getSize();
  if (
    size.width !== assets.width ||
    size.height !== assets.height ||
    incoming.toBitmap().length !== imageData.length
  )
    throw new McpEditError(
      "invalid_edit",
      "Native uploaded PNG dimensions differ from the validated image.",
    );
  const pixels = incoming.toBitmap(),
    pageMask = new Uint8Array(page.width * page.height);
  const hidden = new Uint8Array(pageMask.length).fill(1);
  const changedPixels = applyPatchPixels({
    rect,
    imageData,
    pixels,
    mask: mask.selected,
    before,
    after,
    pageMask,
    hidden,
    width: page.width,
  });
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

function applyPatchPixels(input: {
  rect: { x: number; y: number; w: number; h: number };
  imageData: Buffer;
  pixels: Buffer;
  mask: Uint8Array;
  before: Buffer;
  after: Buffer;
  pageMask: Uint8Array;
  hidden: Uint8Array;
  width: number;
}) {
  const {
    rect,
    imageData,
    pixels,
    mask,
    before,
    after,
    pageMask,
    hidden,
    width,
  } = input;
  let changedPixels = 0;
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const source = y * rect.w + x,
        target = (y + rect.y) * width + x + rect.x;
      if (!mask[source]) continue;
      if (imageData[source * 4 + 3] !== 255)
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
  return changedPixels;
}
