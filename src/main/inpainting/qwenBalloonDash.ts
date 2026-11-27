import type { InpaintingWindowMask } from "./inpaintingEngine";
import type { PixelRect } from "./maskGeometry";
import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import { maskComponents } from "./rasterMasks";

/** A detector can stop at the last kana and miss a long printed dash inside
 * the selected OCR rectangle. Measure the preceding type and both paper banks
 * in reading order, including when the text direction metadata is missing. */
export function registerBalloonDash(
  bitmap: Buffer,
  width: number,
  instance: InpaintingWindowMask,
  box: PixelRect,
  balloon: InpaintingWindowMask,
) {
  const cross = Math.min(box.w, box.h);
  const along = Math.max(box.w, box.h);
  if (cross < 8 || along < 2.7 * cross || along > 660) return;
  const vertical = box.h > box.w;
  const pixel = (u: number, v: number) =>
    vertical ? v * box.w + u : u * box.w + v;
  const ink = projectWindowMask(instance, box);
  const owned = projectWindowMask(balloon, box);
  const tone = Uint8Array.from(ink, (_, i) => {
    const offset =
      4 * ((box.y + Math.floor(i / box.w)) * width + box.x + (i % box.w));
    return Math.max(bitmap[offset], bitmap[offset + 1], bitmap[offset + 2]);
  });
  const dark = Uint8Array.from(tone, (_, i) =>
    Number(tone[pixel(i % cross, Math.floor(i / cross))] < 180),
  );
  const strokes = maskComponents(dark, cross, along, 20).filter(
    ({ rect: r, area }) =>
      r.w <= 4 &&
      r.h >= Math.max(21, 8 * r.w) &&
      area >= 0.79 * r.w * r.h &&
      r.y >= 0.48 * along &&
      r.y + r.h <= along - 3 &&
      r.x >= 4 &&
      r.x + r.w + 4 <= cross,
  );
  if (strokes.length !== 1) return;
  const dash = strokes[0].rect;
  const scan = { dark, ink, pixel, cross };
  if (
    !hasPaperBanks(dash, along, pixel, tone, owned) ||
    !matchesType(dash, previousType(dash.y, scan))
  )
    return;
  const data = new Uint8Array(ink.length);
  for (let v = dash.y; v < dash.y + dash.h; v++)
    for (let u = dash.x; u < dash.x + dash.w; u++)
      data[pixel(u, v)] = dark[v * cross + u];
  return { bounds: box, data };
}

type PixelIndex = (across: number, along: number) => number;
type Band = {
  top: number;
  bottom: number;
  left: number;
  right: number;
  count: number;
  selected: number;
};
function hasPaperBanks(
  dash: PixelRect,
  along: number,
  pixel: PixelIndex,
  tone: Uint8Array,
  owned: Uint8Array,
) {
  let bright = 0,
    shell = 0;
  for (let v = dash.y - 4; v < Math.min(along, dash.y + dash.h + 4); v++)
    for (let u = dash.x - 4; u < dash.x + dash.w + 4; u++) {
      const i = pixel(u, v);
      if (!owned[i]) return false;
      if (
        u >= dash.x - 1 &&
        u <= dash.x + dash.w &&
        v >= dash.y - 1 &&
        v <= dash.y + dash.h
      )
        continue;
      if (tone[i] < 231) return false;
      bright += Number(tone[i] >= 244);
      shell++;
    }
  return bright >= 0.94 * shell;
}
function previousType(
  end: number,
  scan: { cross: number; dark: Uint8Array; ink: Uint8Array; pixel: PixelIndex },
) {
  const { cross, dark, ink, pixel } = scan;
  // Group neighbouring printed rows. Disconnected strokes of one kana can
  // have a one- or two-pixel gap. Each of the last three glyphs must be owned.
  const bands: Band[] = [];
  for (let v = 0; v < end; v++) {
    for (let u = 0; u < cross; u++) {
      if (!dark[v * cross + u]) continue;
      let band = bands.at(-1);
      if (!band || v > band.bottom + 3) {
        band = { top: v, bottom: v, left: u, right: u, count: 0, selected: 0 };
        bands.push(band);
      }
      band.bottom = v;
      band.left = Math.min(band.left, u);
      band.right = Math.max(band.right, u);
      band.count++;
      band.selected += Number(Boolean(ink[pixel(u, v)]));
    }
  }
  return bands.filter((b) => b.bottom - b.top >= 5).slice(-3);
}
function matchesType(dash: PixelRect, anchors: Band[]) {
  if (anchors.length !== 3) return false;
  const axis = dash.x + dash.w / 2;
  const widths = anchors.map((b) => b.right + 1 - b.left);
  const pitch =
    (anchors[2].top +
      anchors[2].bottom -
      (anchors[0].top + anchors[0].bottom)) /
    4;
  const em = anchors.reduce((n, b) => n + b.bottom - b.top + 1, 0) / 3;
  if (
    Math.min(...widths) < 0.35 * em ||
    Math.max(...widths) > 1.65 * em ||
    Math.min(...widths) < 0.35 * Math.max(...widths) ||
    dash.h < 0.55 * em ||
    dash.h > 3.2 * pitch ||
    dash.y - anchors[2].bottom - 1 > 0.42 * pitch ||
    !anchors.every(
      (b, j) =>
        b.count >= 18 &&
        b.selected >= 0.55 * b.count &&
        axis >= b.left + 0.29 * widths[j] &&
        axis <= b.left + 0.71 * widths[j],
    )
  )
    return false;
  return true;
}
