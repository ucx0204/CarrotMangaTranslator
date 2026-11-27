import { nativeImage, type NativeImage } from "electron";
import { maskBoundsInRect } from "./imageRaster";
import { expandRect } from "./maskGeometry";
import { dilateBinaryMaskDisk } from "./patternMaskMorphology";

const side = 512;

/** Separate the translucent red shadow from the monochrome printing. Only
 * opaque ink needs an estimate. White padding avoids reflecting a nearby
 * figure into a word at the edge of a page. */
export async function restoreOverlayStock(
  source: NativeImage,
  stencil: Uint8Array,
  restore: (image: NativeImage, mask: NativeImage) => Promise<NativeImage>,
) {
  const size = source.getSize(),
    box = maskBoundsInRect(stencil, size.width, {
      x: 0,
      y: 0,
      w: size.width,
      h: size.height,
    });
  if (!box) return source;
  const view = expandRect(box, size.width, size.height, 32);
  const tile = { width: view.w, height: view.h };
  const original = source.toBitmap(),
    gray = Buffer.alloc(view.w * view.h * 4);
  const holes = new Uint8Array(view.w * view.h);
  for (let i = 0; i < holes.length; i++) {
    const src =
      (view.y + Math.floor(i / view.w)) * size.width + view.x + (i % view.w);
    const [v, opaque] = separateInk(original, src, stencil[src] !== 0);
    gray.fill(v, i * 4, i * 4 + 3);
    gray[4 * i + 3] = 255;
    holes[i] = opaque;
  }
  const domain = dilateBinaryMaskDisk(holes, view.w, view.h, 2);
  const mask = Buffer.alloc(gray.length, 255);
  domain.forEach((on, i) => mask.fill(on ? 255 : 0, i * 4, i * 4 + 3));
  const scale = Math.min(1, side / view.w, side / view.h);
  const fit = {
    width: Math.max(1, Math.round(view.w * scale)),
    height: Math.max(1, Math.round(view.h * scale)),
  };
  const roi = {
    x: Math.floor((side - fit.width) / 2),
    y: Math.floor((side - fit.height) / 2),
    ...fit,
  };
  const image = padTile(gray, tile, roi, true),
    ink = padTile(mask, tile, roi, false);
  const estimate = (await restore(image, ink))
    .crop(roi)
    .resize(tile)
    .toBitmap();
  for (let i = 0; i < domain.length; i++) {
    const src =
      (view.y + Math.floor(i / view.w)) * size.width + view.x + (i % view.w);
    if (!stencil[src]) continue;
    const at = i * 4;
    const color = domain[i]
      ? Math.round((estimate[at] + 2 * estimate[at + 1] + estimate[at + 2]) / 4)
      : gray[at];
    original.fill(color, src * 4, src * 4 + 3);
  }
  return nativeImage.createFromBitmap(original, size);
}

function separateInk(original: Buffer, pixel: number, owned: boolean) {
  const i = pixel * 4,
    b = original[i],
    g = original[i + 1],
    r = original[i + 2];
  if (!owned) return [Math.round((b + 2 * g + r) / 4), 0] as const;
  const warm = r - Math.min(g, b),
    alpha = Math.max(0, r - g) / 177;
  let intensity = Math.round(
    Math.min(255, Math.max(0, (g - 26 * alpha) / Math.max(0.05, 1 - alpha))),
  );
  if (intensity > 232 && warm > 7) intensity = Math.min(255, intensity + 8);
  return [
    intensity,
    Number(warm > 40 || g - b > Math.max(12, 0.2 * warm)),
  ] as const;
}

function padTile(
  bytes: Buffer,
  size: Electron.Size,
  rect: Electron.Rectangle,
  white: boolean,
) {
  const image = nativeImage
    .createFromBitmap(bytes, size)
    .resize({ width: rect.width, height: rect.height, quality: "best" })
    .toBitmap();
  const square = Buffer.alloc(side * side * 4, white ? 255 : 0);
  if (!white) for (let i = 3; i < square.length; i += 4) square[i] = 255;
  for (let y = 0; y < rect.height; y++)
    image.copy(
      square,
      4 * ((rect.y + y) * side + rect.x),
      4 * y * rect.width,
      4 * (y + 1) * rect.width,
    );
  return nativeImage.createFromBitmap(square, { width: side, height: side });
}
