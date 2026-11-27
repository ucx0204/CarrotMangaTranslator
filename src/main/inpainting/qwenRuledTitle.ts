import type { InpaintingWindowMask } from "./inpaintingEngine";
import { mergeMaskIntoPage, type PixelRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { nativeLuminance } from "./qwenOutlinedLettering";
import { maskComponents } from "./rasterMasks";

type Part = ReturnType<typeof maskComponents>[number];
export type QwenRuledTitleBand = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

/** Pale illustrated title plates have a measurable light floor on the clear
 * stock next to their rules. Keep that illustration available to the decoder
 * between the printed strokes, even when OCR clipped a character at the end. */
export function recoverQwenRuledTitle(
  bitmap: Buffer,
  size: { width: number; height: number },
  selection: PixelRect,
): (InpaintingWindowMask & { titleBand: QwenRuledTitleBand }) | undefined {
  const { x, y, w, h } = selection;
  if (w < 0.31 * size.width || w < 3.2 * h || h < 26 || h * w > 580000) return;
  const pad = Math.min(0.21 * w, 1.75 * h);
  const left = Math.max(0, Math.round(x - pad)),
    top = Math.max(0, Math.round(y - 1.25 * h));
  const bounds = {
    x: left,
    y: top,
    w: Math.min(size.width, Math.round(x + w + pad)) - left,
    h: Math.min(size.height, Math.round(y + h + 1.25 * h)) - top,
  };
  const tone = nativeLuminance(bitmap, size.width, bounds);
  const selected = { ...selection, x: x - left, y: y - top };
  const band = ruledBand(tone, bounds.w, bounds.h, selected);
  if (!band) return;
  const inside = tone.subarray(band.top * bounds.w, band.bottom * bounds.w);
  const mask = inside.map((v) => Number(v < band.ceiling));
  const rowHeight = band.bottom - band.top;
  const matching = maskComponents(mask, bounds.w, rowHeight, 3).filter((p) =>
    plausiblePart(p, bounds.w, rowHeight, selected, band.top),
  );
  const letters = alongBaseline(matching, selected);
  if (!letters) return;
  const core = new Uint8Array(mask.length);
  for (const part of letters) {
    mergeMaskIntoPage(core, bounds.w, part.rect, part.data);
    fillSmallCounters(core, bounds.w, part, h);
  }
  const area = core.reduce((sum, v) => sum + v, 0) / core.length;
  if (area < 0.045 || area > 0.56) return;
  const distance = distanceToMask(core, bounds.w, rowHeight);
  const data = core.map((_, i) => Number(distance[i] < 2.4));
  const restored = completeRuleMedallions(
    core,
    tone,
    bounds.w,
    band.top,
    rowHeight,
    data,
  );
  const start = band.top - restored.above;
  recoverTitleCompression(
    tone.subarray(start * bounds.w, band.bottom * bounds.w),
    restored.data,
    bounds.w,
    restored.above,
  );
  return {
    titleBand: {
      left: selection.x,
      right: selection.x + selection.w,
      top: bounds.y + band.top - 1,
      bottom: bounds.y + band.bottom,
    },
    bounds: {
      x: bounds.x,
      y: bounds.y + band.top - restored.above,
      w: bounds.w,
      h: rowHeight + restored.above,
    },
    data: restored.data,
  };
}

/** JPEG ringing beside black lettering on a pale stock can extend beyond
 * the last dark pixel. Measure its excess over the surrounding illustration
 * before changing the crop's write authority. */
function recoverTitleCompression(
  tone: Uint8Array,
  mask: Uint8Array,
  width: number,
  above: number,
) {
  const height = mask.length / width;
  const distance = distanceToMask(mask, width, height);
  if (!printedRinging(tone, distance, width, height, above)) return;
  for (let y = 0; y < height; y++) {
    // The measured top and bottom rules and their printed shoulders stay intact.
    if (Math.abs(y - above) <= 2 || y >= height - 2) continue;
    for (let i = y * width; i < (y + 1) * width; i++) {
      if (distance[i] < 4 && tone[i] > 145) mask[i] = 1;
    }
  }
}

function printedRinging(
  tone: Uint8Array,
  distance: Float32Array,
  width: number,
  height: number,
  above: number,
) {
  const total = [0, 0],
    rough = [0, 0];
  for (let y = above + 5; y < height - 5; y++) {
    for (let x = 5; x < width - 5; x++) {
      const i = y * width + x,
        d = distance[i];
      if (d < 1 || (d >= 3.5 && d < 6) || d >= 10 || tone[i] <= 150) continue;
      const l = tone[i - 1],
        r = tone[i + 1],
        t = tone[i - width],
        b = tone[i + width];
      if (Math.min(l, r, t, b) <= 145) continue;
      const ring = Number(d >= 6);
      total[ring]++;
      rough[ring] += Number(Math.abs(4 * tone[i] - l - r - t - b) > 14);
    }
  }
  const edge = rough[0] / total[0],
    stock = rough[1] / total[1];
  return (
    Math.min(...total) >= 180 &&
    edge >= Math.max(0.21, stock + 0.12, stock * 1.45)
  );
}

/** Opposite sides of the same observed rule share a crop when both title rows
 * were selected. A third row retains its own budget and output mask. */
export function pairQwenTitleWindows(
  unpaired: Map<number, QwenRuledTitleBand>,
  groups: string[][],
  band: QwenRuledTitleBand | undefined,
) {
  if (!band) return;
  const current = groups.length - 1;
  for (const [index, other] of unpaired) {
    const overlap =
      Math.min(band.right, other.right) - Math.max(band.left, other.left);
    if (
      overlap <
      0.65 * Math.max(band.right - band.left, other.right - other.left)
    )
      continue;
    if (
      Math.min(
        Math.abs(band.top - other.bottom),
        Math.abs(band.bottom - other.top),
      ) > 4
    )
      continue;
    const id = `qwen-title-rule-${index}-${current}`;
    groups[index].push(id);
    groups[current].push(id);
    unpaired.delete(index);
    return;
  }
  unpaired.set(current, band);
}

/** A printed seal can hide part of a separator. Only include it when its
 * measured silhouette is closed below and visibly interrupts the black rule. */
function completeRuleMedallions(
  core: Uint8Array,
  tone: Uint8Array,
  w: number,
  top: number,
  h: number,
  data: Uint8Array,
) {
  const above = Math.min(top, Math.ceil(0.23 * h));
  if (!above || !core.subarray(0, w).some(Boolean)) return { above: 0, data };
  let expanded: Uint8Array | undefined;
  for (const part of maskComponents(core.subarray(3 * w), w, h - 3, 45)) {
    const fit = printedDiamond(part, h);
    if (!fit || !interruptsRule(tone, w, top, fit.x, fit.rx)) continue;
    if (!expanded) {
      expanded = new Uint8Array(w * (h + above));
      expanded.set(data, above * w);
    }
    const cy = fit.y + 3 + above;
    for (
      let y = Math.max(0, Math.floor(cy - fit.ry - 2));
      y < Math.min(h + above, cy + fit.ry + 2);
      y++
    ) {
      const half = fit.rx * (1.045 - Math.abs(y - cy) / fit.ry);
      if (half <= 0) continue;
      expanded.fill(
        1,
        y * w + Math.max(0, Math.floor(fit.x - half)),
        y * w + Math.min(w, 1 + Math.ceil(fit.x + half)),
      );
    }
  }
  return expanded ? { above, data: expanded } : { above: 0, data };
}

function printedDiamond({ rect, data }: Part, height: number) {
  if (
    rect.y ||
    Math.min(rect.w, rect.h) < 12 ||
    Math.max(rect.w, rect.h) > 0.81 * height
  )
    return;
  const spans = Array.from({ length: rect.h }, (_, i) => {
    const row = data.subarray(i * rect.w, (i + 1) * rect.w);
    return [row.indexOf(1), row.lastIndexOf(1)];
  });
  const widest = spans.findIndex(([l, r]) => r - l >= rect.w - 2);
  if (widest < 0) return;
  const rx = (rect.w - 1) / 2,
    ry = rect.h - 1 - widest;
  if (ry < 0.81 * rx || ry > 1.19 * rx || widest >= ry) return;
  let matched = 0;
  for (const [y, [l, r]] of spans.entries()) {
    const expected = rx * (1 - Math.abs(y - widest) / ry);
    if (
      Math.abs(expected - (r - l) / 2) < Math.max(2, 0.1 * rx) &&
      Math.abs((l + r) / 2 - rx) < Math.max(2, 0.11 * rx)
    )
      matched++;
  }
  if (matched > 0.82 * rect.h) return { x: rect.x + rx, y: widest, rx, ry };
}

function interruptsRule(
  tone: Uint8Array,
  w: number,
  top: number,
  x: number,
  rx: number,
) {
  const row = tone.subarray((top - 1) * w, top * w);
  const center = Math.round(x),
    side = Math.round(rx * 0.72);
  if (center <= side + 2 || center + side + 2 >= w) return false;
  const border = Math.max(row[center - side], row[center + side]);
  return (
    border < 85 &&
    Math.min(row[center - 1], row[center], row[center + 1]) > border + 37
  );
}

function ruledBand(
  tone: Uint8Array,
  w: number,
  h: number,
  selected: PixelRect,
) {
  const left = selected.x + Math.floor(0.06 * selected.w);
  const right = selected.x + selected.w - Math.floor(0.06 * selected.w);
  let top = -1,
    bottom = -1;
  for (let y = 0; y < h; y++) {
    let dark = 0;
    for (let x = left; x < right; x++) dark += Number(tone[y * w + x] < 145);
    if (dark <= 0.82 * (right - left)) continue;
    if (y < selected.y + 0.2 * selected.h) top = y + 1;
    if (y > selected.y + 0.8 * selected.h && bottom < 0) bottom = y;
  }
  const height = bottom - top;
  if (
    top < 0 ||
    bottom < 0 ||
    height < 0.75 * selected.h ||
    height > 3.15 * selected.h
  )
    return;
  const ceiling = stockFloor(tone, w, left, right, top, bottom);
  if (ceiling !== undefined) return { top, bottom, ceiling };
}

function stockFloor(
  tone: Uint8Array,
  w: number,
  left: number,
  right: number,
  top: number,
  bottom: number,
) {
  const width = Math.max(3, Math.round(0.058 * (bottom - top)));
  const counts = new Uint32Array(256);
  for (let delta = 3; delta < 3 + width; delta++)
    for (let x = left; x < right; x++) {
      counts[tone[(top + delta) * w + x]]++;
      counts[tone[(bottom - delta - 1) * w + x]]++;
    }
  const limit = 0.06 * 2 * width * (right - left);
  let count = 0;
  for (let value = 0; value < 256; value++) {
    count += counts[value];
    if (count > limit)
      return value >= 168 ? Math.min(168, value - 13) : undefined;
  }
}

function plausiblePart(
  part: Part,
  w: number,
  h: number,
  selected: PixelRect,
  top: number,
) {
  const p = part.rect;
  if (
    Math.min(p.x, w - p.x - p.w) < 3 ||
    Math.min(p.w, p.h) < 2 ||
    p.h >= 0.96 * h ||
    p.w > 0.48 * selected.w
  )
    return false;
  if (hugsRule(p, h)) return false;
  if (
    part.area < 12 &&
    (p.x < selected.x || p.x + p.w > selected.x + selected.w)
  )
    return false;
  const center = top + p.y + 0.5 * p.h;
  return (
    center >= selected.y - 0.09 * selected.h &&
    center <= selected.y + 1.09 * selected.h
  );
}

function hugsRule(p: PixelRect, h: number) {
  return (
    (p.y <= 1 && p.y + p.h < 0.22 * h) ||
    (p.y >= 0.81 * h && p.y + p.h >= h - 1)
  );
}

function alongBaseline(parts: Part[], selected: PixelRect) {
  const anchors = parts.filter(({ area, rect }) => {
    const center = rect.x + 0.5 * rect.w;
    return (
      area >= Math.max(30, 0.018 * selected.h ** 2) &&
      center >= selected.x &&
      center <= selected.x + selected.w
    );
  });
  if (anchors.length < 5) return;
  const centers = anchors.map(({ rect }) => rect.x + 0.5 * rect.w);
  if (Math.max(...centers) - Math.min(...centers) < 0.53 * selected.w) return;
  let group = anchors;
  const gap = 0.4 * selected.h;
  for (let pass = 0; pass < 3; pass++) {
    const left = Math.min(...group.map(({ rect }) => rect.x));
    const right = Math.max(...group.map(({ rect }) => rect.x + rect.w));
    group = parts.filter(
      ({ rect }) => rect.x < right + gap && rect.x + rect.w > left - gap,
    );
  }
  return group;
}

function fillSmallCounters(
  core: Uint8Array,
  w: number,
  part: Part,
  height: number,
) {
  const size = part.rect;
  const holes = maskComponents(
    part.data.map((v) => 1 - v),
    size.w,
    size.h,
    1,
  );
  const maxArea = Math.max(10, 0.0019 * height ** 2);
  for (const hole of holes) {
    const b = hole.rect;
    if (
      hole.area >= maxArea ||
      Math.min(b.x, b.y, size.w - b.x - b.w, size.h - b.y - b.h) === 0
    )
      continue;
    mergeMaskIntoPage(
      core,
      w,
      { ...b, x: size.x + b.x, y: size.y + b.y },
      hole.data,
    );
  }
}
