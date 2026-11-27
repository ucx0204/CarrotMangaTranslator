import { bboxOverlapRatio } from "../../shared/geometry";
import type { MangaPage } from "../../shared/libraryTypes";
import type { KoharuTypographySegmentation } from "../bubbleLayout/contracts";
import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import {
  nativeKoharuTextInstance,
  trimWindowMask,
} from "./koharuTypographyMask";
import type { PixelRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { hasPairedCreatorCredit } from "./qwenCreatorCaption";
import { groupedDiamondBacking } from "./qwenDiamondStock";
import { measurePublisherRibbon } from "./qwenCaptionStock";
import { nativeLuminance } from "./qwenOutlinedLettering";
import { measureCreatorCaptions } from "./qwenPrintGlow";
import { maskComponents } from "./rasterMasks";
import { fillEnclosedMaskHoles } from "../bubbleLayout/bubbleMaskComponents";
import { continuePublisherGlow } from "./qwenPublisherGlow";

function wholeRow(bounds: PixelRect) {
  return { bounds, data: new Uint8Array(bounds.w * bounds.h).fill(1) };
}

function lettersOnLightStock(
  bitmap: Buffer,
  stride: number,
  bounds: PixelRect,
) {
  const gray = nativeLuminance(bitmap, stride, bounds);
  const dark = gray.map((v) => Number(v < 159));
  const letters = new Uint8Array(gray.length);
  for (const { rect, area, data } of maskComponents(
    dark,
    bounds.w,
    bounds.h,
    4,
  )) {
    if (rect.w > 0.84 * bounds.w || rect.h > bounds.h) continue;
    let lit = 0,
      sampled = 0,
      thick = false;
    data.forEach((on, j) => {
      if (!on) return;
      const x = rect.x + (j % rect.w),
        y = rect.y + Math.floor(j / rect.w);
      const i = y * bounds.w + x;
      if (x <= 0 || x + 1 >= bounds.w || y <= 0 || y + 1 >= bounds.h) return;
      const adjacent = [i - 1, i + 1, i - bounds.w, i + bounds.w];
      if (adjacent.every((k) => dark[k])) thick = true;
      for (const k of adjacent) {
        if (dark[k]) continue;
        sampled++;
        lit += Number(gray[k] >= 211);
      }
    });
    if (sampled < 2 || lit < 0.5 * sampled || (!thick && area < 26)) continue;
    data.forEach((on, j) => {
      if (on)
        letters[
          (rect.y + Math.floor(j / rect.w)) * bounds.w + rect.x + (j % rect.w)
        ] = 1;
    });
  }
  return { bounds, data: letters };
}

function longRules(data: Uint8Array, rect: PixelRect) {
  const matched = [];
  for (let y = 0; y < rect.h; y++) {
    let run = 0;
    for (let x = 0; x < rect.w; x++) {
      run = data[y * rect.w + x] ? run + 1 : 0;
      if (run < Math.max(28, 0.41 * rect.w)) continue;
      matched.push(y);
      break;
    }
  }
  return (
    matched.length > 1 &&
    matched[matched.length - 1] - matched[0] >= 0.38 * rect.h
  );
}

function isRuledFrame(rect: PixelRect, area: number, data: Uint8Array) {
  const { w, h } = rect;
  return (
    w >= 46 &&
    h >= 10 &&
    h <= 130 &&
    w >= 2.2 * h &&
    w <= 22 * h &&
    area <= 0.24 * w * h &&
    longRules(data, rect)
  );
}

/** A publisher can put a thin ruled box around one line of a larger title.
 * Its joined tail belongs to the same imprint even outside the OCR rectangle. */
export function enclosedPublisherStock(
  gray: Uint8Array,
  selected: Uint8Array,
  bounds: PixelRect,
) {
  const print = gray.map((value) => Number(value <= 170));
  const stock = new Uint8Array(gray.length);
  for (const { rect, area, data } of maskComponents(
    print,
    bounds.w,
    bounds.h,
    80,
  )) {
    const { w, h } = rect;
    if (!isRuledFrame(rect, area, data)) continue;
    const toPage = (i: number) =>
      (rect.y + Math.floor(i / w)) * bounds.w + rect.x + (i % w);
    const hits = data.reduce(
      (sum, on, i) => sum + Number(!!on && !!selected[toPage(i)]),
      0,
    );
    if (hits < 0.94 * area) continue;
    const inside = fillEnclosedMaskHoles(data, w, h);
    let count = 0,
      letters = 0,
      white = 0;
    inside.forEach((on, i) => {
      if (!on || data[i]) return;
      const at = toPage(i);
      count++;
      letters += Number(!!selected[at] && gray[at] < 130);
      white += Number(gray[at] > 225);
    });
    if (count < 0.3 * w * h || letters < 0.035 * count || white < 0.43 * count)
      continue;
    inside.forEach((on, i) => {
      if (on) stock[toPage(i)] = 1;
    });
  }
  if (!stock.some(Boolean)) return stock;
  return Uint8Array.from(distanceToMask(stock, bounds.w, bounds.h), (v, i) =>
    Number(v < 2.5 || (v < 5.5 && gray[i] > 219)),
  );
}

/** The model can see an entire stack of publisher lettering at once. Limit
 * its paste to the actual typeset rows, their white keylines and the small
 * shared-baseline credits. This keeps neighbouring drawn highlights intact. */
export function publisherRowComposite(
  options: {
    bitmap: Buffer;
    page: MangaPage;
    typographySegmentation?: KoharuTypographySegmentation;
  },
  rows: Row[] | undefined,
  base: InpaintingWindowMask,
  bounds: PixelRect,
) {
  const segmentation = options.typographySegmentation;
  if (!rows || rows.length < 3 || !segmentation) return;
  const { bitmap, page } = options;
  const { width } = page;
  const selected = projectWindowMask(base, bounds);
  const raw = new Uint8Array(selected.length),
    type = raw.slice(),
    row = raw.slice(),
    credits = raw.slice();
  addDetectedRows(segmentation, rows, options.page, bounds, raw);
  if (!rows.some((r) => hasPairedCreatorCredit(r.reading)))
    return diamondTitleComposite(options, rows, base, bounds, raw, selected);
  if (rows.length < 4 || !raw.some(Boolean)) return;
  for (const { rect, reading } of rows) {
    projectWindowMask(wholeRow(rect), bounds, row);
    projectWindowMask(lettersOnLightStock(bitmap, width, rect), bounds, type);
    const fine = measureCreatorCaptions(
      options.bitmap,
      options.page,
      rect,
      reading,
      { bounds, data: raw },
    );
    if (fine) projectWindowMask(fine, bounds, credits);
  }
  const gray = nativeLuminance(options.bitmap, width, bounds);
  const cartouches = enclosedPublisherStock(gray, selected, bounds);
  const near = (data: Uint8Array) => distanceToMask(data, bounds.w, bounds.h);
  const baseDistance = near(selected),
    detected = near(raw),
    printed = near(type),
    rowDistance = near(row);
  const data = selected.map((on, i) =>
    Number(
      credits[i] ||
        cartouches[i] ||
        ((on || lightStockEdge(gray, i, bounds.w, baseDistance[i])) &&
          (rowDistance[i] < 5 ||
            detected[i] < 14 ||
            printed[i] < (gray[i] > 218 ? 13 : 9))),
    ),
  );
  if (data.some(Boolean))
    return trimWindowMask({
      bounds,
      data: continuePublisherGlow(gray, data, bounds, printed, detected),
    });
}

function diamondTitleComposite(
  options: { bitmap: Buffer; page: MangaPage },
  rows: Row[],
  base: InpaintingWindowMask,
  bounds: PixelRect,
  raw: Uint8Array,
  selected: Uint8Array,
) {
  const tallest = Math.max(...rows.map(({ rect }) => rect.h));
  if (tallest < 120) return;
  const plaques = new Uint8Array(raw.length),
    preservedPen = plaques.slice(),
    small = plaques.slice();
  for (const { rect } of rows) {
    if (rect.h > 0.48 * tallest) continue;
    const backing = groupedDiamondBacking(
      options.bitmap,
      options.page.width,
      options.page.height,
      rect,
      base,
      true,
    );
    if (backing) {
      projectWindowMask(backing, bounds, plaques);
      if (backing.preservedPen)
        projectWindowMask(
          { bounds: backing.bounds, data: backing.preservedPen },
          bounds,
          preservedPen,
        );
      continue;
    }
    const ribbon = measurePublisherRibbon(options.bitmap, options.page, rect);
    if (ribbon) projectWindowMask(ribbon, bounds, small);
    projectWindowMask(wholeRow(rect), bounds, small);
  }
  if (!plaques.some(Boolean) || !raw.some(Boolean)) return;
  const near = (data: Uint8Array) => distanceToMask(data, bounds.w, bounds.h);
  const ink = near(raw),
    caption = near(small),
    backing = near(plaques),
    model = near(selected);
  const gray = nativeLuminance(options.bitmap, options.page.width, bounds);
  const creditInk = near(
    small.map((on, i) => Number(on && !plaques[i] && gray[i] < 224)),
  );
  const titleShoulder = Math.min(23, Math.max(15.5, 0.09 * tallest));
  // The white area around the display title can include unprinted highlights
  // and clothing. Only extend the paste where native glyphs or the measured
  // black backing justify it. Small credit rows share the same model view.
  const data = selected.map((_, i) =>
    Number(
      model[i] < 10 &&
        (plaques[i] ||
          (!preservedPen[i] &&
            caption[i] < 3 &&
            (backing[i] >= 17 || creditInk[i] < 3)) ||
          (backing[i] >= 17 && (ink[i] < titleShoulder || caption[i] < 4))),
    ),
  );
  return trimWindowMask({ bounds, data });
}

function lightStockEdge(
  gray: Uint8Array,
  i: number,
  width: number,
  distance: number,
) {
  if (gray[i] <= 235 || distance >= 4) return false;
  if (gray[i] >= 246 || distance < 2.5) return true;
  // A bright dot on the neighbouring drawing is not a continuation of paper.
  const x = i % width;
  return (
    x > 0 &&
    x + 1 < width &&
    [i - width, i + width, i - 1, i + 1].every((k) => gray[k] >= 231)
  );
}

function addDetectedRows(
  segmentation: KoharuTypographySegmentation,
  rows: Row[],
  page: MangaPage,
  bounds: PixelRect,
  raw: Uint8Array,
) {
  for (const d of segmentation.detections) {
    const [x, y, r, b] = d.box;
    if (
      !rows.some(
        ({ rect }) =>
          bboxOverlapRatio({ x, y, w: r - x, h: b - y }, rect) > 0.52,
      )
    )
      continue;
    const mask = nativeKoharuTextInstance(d, page);
    if (mask) projectWindowMask(mask, bounds, raw);
  }
}

type Row = { rect: PixelRect; reading: string };
