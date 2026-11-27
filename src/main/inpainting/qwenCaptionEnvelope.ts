import {
  isVerticalDisplayCaption,
  measureSceneCaptionRings,
} from "./qwenVerticalCaptionStock";
import { fillEnclosedMaskHoles } from "../bubbleLayout/bubbleMaskComponents";
import { trimWindowMask, unionWindowMasks } from "./koharuTypographyMask";
import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { expandRect, mergeMaskIntoPage, type PixelRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { nativeLuminance } from "./qwenOutlinedLettering";
import { maskComponents } from "./rasterMasks";
import { darkTitleColour, printedColourHalo } from "./qwenColourHalo";

/** A dark caption knocked out in white on a midtone scene has two edges.
 * Leaving the outer edge in the conditioning image gives the model the
 * silhouette of the word. Measure both edges against the original artwork. */
export function keylinedSceneCaption(
  bitmap: Buffer,
  page: { width: number; height: number },
  selected: PixelRect,
  instance: InpaintingWindowMask,
) {
  if (!isVerticalDisplayCaption(selected)) return;
  const bounds = expandRect(selected, page.width, page.height, 12);
  const gray = nativeLuminance(bitmap, page.width, bounds);
  const mask = projectWindowMask(instance, bounds);
  return measureSceneCaptionRings(gray, mask, bounds, selected);
}

/** Keep the measured ink as the model input. A separate soft paste boundary
 * includes the fading outer print without asking for a larger reconstruction. */
export function isolatedLayeredTitle(
  bitmap: Buffer,
  page: { width: number; height: number },
  selected: PixelRect,
) {
  const modelMask = measureLayeredTitle(bitmap, page, selected);
  if (!modelMask) return;
  const bounds = expandRect(modelMask.bounds, page.width, page.height, 19);
  const distance = distanceToMask(
    projectWindowMask(modelMask, bounds),
    bounds.w,
    bounds.h,
  );
  const shoulder = (radius: number) =>
    trimWindowMask({
      bounds,
      data: Uint8Array.from(distance, (d) => Number(d < radius)),
    });
  return {
    modelMask,
    compositeMask: shoulder(8),
    constraint: shoulder(17),
    featherPx: 9,
  };
}

export function measureLayeredTitle(
  bitmap: Buffer,
  page: { width: number; height: number },
  selected: PixelRect,
) {
  const bounds = expandRect(selected, page.width, page.height, 36);
  if (bounds.w * bounds.h > 1_000_000) return;
  const field = darkTitleColour(bitmap, page.width, bounds, selected);
  if (!field) return;
  const { w, h } = bounds,
    core = new Uint8Array(w * h),
    cells = new Set<number>();
  for (const component of maskComponents(field.family, w, h, 6)) {
    const { rect, data, area } = component;
    let near = 0,
      far = 0;
    data.forEach((on, i) => {
      if (!on) return;
      const p = (rect.y + Math.floor(i / rect.w)) * w + rect.x + (i % rect.w);
      near += Number(field.toWhite[p] <= 5);
      far += Number(field.toWhite[p] <= 15);
    });
    if (near < 0.33 * area || far < 0.82 * area) continue;
    mergeMaskIntoPage(core, w, rect, data);
    cells.add(Math.floor((6 * (rect.x + rect.w / 2)) / w));
  }
  if (cells.size < 4) return;
  const distance = distanceToMask(core, w, h);
  const shoulders = core.map((v, i) =>
    Number(
      !!v ||
        (distance[i] < 27 &&
          field.region[i] &&
          field.colour[i] &&
          field.toWhite[i] < 8.5),
    ),
  );
  includeColouredTerminals(shoulders, field, w, h);
  const extended = distanceToMask(shoulders, w, h);
  const paper = shoulders.map((v, i) =>
    Number(!!v || (extended[i] < 23 && field.pale[i])),
  );
  const toPaper = distanceToMask(paper, w, h);
  const data = Uint8Array.from(extended, (g, i) =>
    Number(g < 10 || (g < 37 && toPaper[i] < 8)),
  );
  return { bounds, data };
}

/** A title stroke can change from dark ink to gold or pink well before its
 * tapered end. Follow the connected colour while white print borders both
 * sides. A similarly coloured patch of artwork has only one such edge. */
function includeColouredTerminals(
  shoulders: Uint8Array,
  field: NonNullable<ReturnType<typeof darkTitleColour>>,
  w: number,
  h: number,
) {
  const distance = distanceToMask(shoulders, w, h);
  const colour = field.colour.map((v, i) =>
    Number(v && field.region[i] && field.toWhite[i] < 8 && distance[i] < 112),
  );
  for (const { rect, data, area } of maskComponents(colour, w, h, 18)) {
    let attached = 0,
      beyond = 0,
      bordered = 0;
    data.forEach((on, i) => {
      if (!on) return;
      const x = rect.x + (i % rect.w),
        y = rect.y + Math.floor(i / rect.w);
      const at = y * w + x;
      attached += Number(distance[at] < 4);
      beyond += Number(distance[at] > 10);
      bordered += Number(hasOppositeWhiteEdges(field.pale, x, y, w, h));
    });
    if (attached >= 5 && beyond >= 8 && bordered > 0.52 * area)
      mergeMaskIntoPage(shoulders, w, rect, data);
  }
}

function hasOppositeWhiteEdges(
  pale: Uint8Array,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  for (const step of [3, 5, 8, 11, 14]) {
    for (const [dx, dy] of [
      [step, 0],
      [0, step],
      [step, step],
      [step, -step],
    ]) {
      if (x < dx || x + dx >= w || Math.min(y, h - 1 - y) < Math.abs(dy))
        continue;
      const at = y * w + x,
        offset = dy * w + dx;
      if (pale[at - offset] && pale[at + offset]) return true;
    }
  }
  return false;
}

export function measuredColouredCaption(
  bitmap: Buffer,
  page: { width: number; height: number },
  mask: InpaintingWindowMask,
) {
  const { w, h } = mask.bounds;
  if (
    w < 105 ||
    h < 27 ||
    w < h * 1.1 ||
    w * h > 720_000 ||
    mask.data.reduce((n, v) => n + Number(!!v), 0) < 850
  )
    return;
  const bounds = expandRect(mask.bounds, page.width, page.height, 40);
  const data = printedColourHalo(
    bitmap,
    page.width,
    bounds,
    projectWindowMask(mask, bounds),
  );
  if (data) return { bounds, data };
}

/** Flat white keylines around many printed characters can be measured even
 * where the text crosses a wall, a face or ruled screens. Stop blending at
 * the measured paper edge before it alters adjacent original pen strokes. */
export function measuredCaptionEnvelope(
  bitmap: Buffer,
  page: { width: number; height: number },
  rect: PixelRect,
  instance: InpaintingWindowMask,
) {
  if (
    rect.w < 30 ||
    rect.w > 235 ||
    rect.h < 85 ||
    rect.h > 530 ||
    rect.h < 1.45 * rect.w
  )
    return;
  const bounds = expandRect(instance.bounds, page.width, page.height, 12);
  const { w, h } = bounds;
  const gray = nativeLuminance(bitmap, page.width, bounds);
  const mask = projectWindowMask(instance, bounds);
  const dark = gray.map((v) => Number(v < 153));
  const ink = captionInkOnPaleBorders(gray, dark, mask, w, h);
  if (!ink) return;
  const selected = distanceToMask(mask, w, h);
  if (!hasContinuousPaperEdge(gray, dark, mask, ink, selected, w, h)) return;
  return {
    compositeMask: {
      bounds,
      data: Uint8Array.from(selected, (d) => Number(d <= 4.8)),
    },
    constraint: {
      bounds,
      data: Uint8Array.from(selected, (d) => Number(d <= 6.8)),
    },
    featherPx: 2,
  };
}

function captionInkOnPaleBorders(
  gray: Uint8Array,
  dark: Uint8Array,
  mask: Uint8Array,
  w: number,
  h: number,
) {
  const ink = new Uint8Array(gray.length);
  let count = 0;
  for (const part of maskComponents(dark, w, h, 5)) {
    const b = part.rect;
    if (b.w < 2 || b.w > 30 || b.h < 2 || b.h > 32) continue;
    let covered = 0;
    part.data.forEach((v, i) => {
      if (v)
        covered += Number(
          !!mask[(b.y + Math.floor(i / b.w)) * w + b.x + (i % b.w)],
        );
    });
    if (covered < 0.76 * part.area) continue;
    if (!hasPaleBorder(part, gray, w, h)) continue;
    mergeMaskIntoPage(ink, w, b, part.data);
    count++;
  }
  if (count >= 14) return ink;
}

function hasPaleBorder(
  part: ReturnType<typeof maskComponents>[number],
  gray: Uint8Array,
  w: number,
  h: number,
) {
  const b = part.rect;
  const sampleBox = expandRect(b, w, h, 4);
  const samples = new Uint8Array(sampleBox.w * sampleBox.h);
  mergeMaskIntoPage(
    samples,
    sampleBox.w,
    { ...b, x: b.x - sampleBox.x, y: b.y - sampleBox.y },
    part.data,
  );
  let pale = 0,
    seen = 0;
  distanceToMask(samples, sampleBox.w, sampleBox.h).forEach((d, i) => {
    if (d < 1.8 || d > 3.5) return;
    const p =
      (sampleBox.y + Math.floor(i / sampleBox.w)) * w +
      sampleBox.x +
      (i % sampleBox.w);
    pale += Number(gray[p] > 222);
    seen++;
  });
  return seen > 0 && pale >= 0.63 * seen;
}

function hasContinuousPaperEdge(
  gray: Uint8Array,
  dark: Uint8Array,
  mask: Uint8Array,
  ink: Uint8Array,
  selected: Float32Array,
  w: number,
  h: number,
) {
  let covered = 0,
    total = 0,
    white = 0,
    edge = 0,
    art = 0,
    outer = 0;
  distanceToMask(ink, w, h).forEach((d, i) => {
    if (dark[i] && mask[i]) {
      total++;
      covered += ink[i];
    }
    if (d >= 2 && d < 4) {
      edge++;
      white += Number(gray[i] > 215);
    }
    if (selected[i] > 5 && selected[i] < 10) {
      outer++;
      art += Number(gray[i] < 195);
    }
  });
  return !(
    covered < 0.86 * total ||
    !edge ||
    white < 0.9 * edge ||
    !outer ||
    art < 0.09 * outer
  );
}

type Part = ReturnType<typeof maskComponents>[number];
function hasLetterProportions(rect: PixelRect, area: number) {
  return !(
    Math.min(rect.w, rect.h) < 7 ||
    Math.max(rect.w, rect.h) > 140 ||
    area < 0.35 * rect.w * rect.h ||
    rect.w > 3 * rect.h ||
    rect.h > 3 * rect.w
  );
}

function measuredOutline(
  part: Part,
  bounds: PixelRect,
  field: Uint8Array,
  core: Uint8Array,
) {
  const { rect, data, area } = part;
  if (!hasLetterProportions(rect, area)) return;
  const edge = expandRect(rect, bounds.w, bounds.h, 5);
  if (edge.w !== rect.w + 10 || edge.h !== rect.h + 10) return;
  const ink = projectWindowMask({ bounds: rect, data }, edge);
  const distance = distanceToMask(ink, edge.w, edge.h);
  let selected = 0,
    band = 0,
    dark = 0,
    medium = 0;
  for (let i = 0; i < distance.length; i++) {
    const at =
      (edge.y + Math.floor(i / edge.w)) * bounds.w + edge.x + (i % edge.w);
    if (ink[i]) selected += Number(!!core[at]);
    else if (distance[i] <= 3) {
      band++;
      dark += Number(field[at] < 120);
      medium += Number(field[at] < 190);
    }
  }
  if (
    band &&
    dark >= 0.45 * band &&
    medium >= 0.69 * band &&
    selected >= 0.07 * area
  )
    return { part, edge, selected: selected / area };
}

function neighbouringLetter(part: Part, { rect }: Part, size: number) {
  const otherSize = Math.max(rect.w, rect.h);
  const dx = Math.max(
    0,
    rect.x - part.rect.x - part.rect.w,
    part.rect.x - rect.x - rect.w,
  );
  const dy = Math.max(
    0,
    rect.y - part.rect.y - part.rect.h,
    part.rect.y - rect.y - rect.h,
  );
  return (
    otherSize >= 0.45 * size &&
    otherSize <= 3 * size &&
    Math.hypot(dx, dy) <= 2 * size
  );
}

/** A detector can split a kanji at an internal black keyline. Recover a
 * partly selected white component only when nearby selected print has the
 * same white fill and measured dark rim. */
export function completeOutlinedWhitePrint(
  bitmap: Buffer,
  stride: number,
  instance: InpaintingWindowMask,
  bounds: PixelRect,
) {
  if (bounds.w * bounds.h > 1_300_000 || Math.min(bounds.w, bounds.h) < 42)
    return instance;
  const field = nativeLuminance(bitmap, stride, bounds);
  const core = projectWindowMask(instance, bounds);
  const parts = [];
  for (const part of maskComponents(
    field.map((v) => Number(v >= 233)),
    bounds.w,
    bounds.h,
    42,
  )) {
    const outline = measuredOutline(part, bounds, field, core);
    if (outline) parts.push(outline);
  }
  const peers = parts.filter((p) => p.selected >= 0.92);
  let mask = instance;
  for (const { part, edge, selected } of parts) {
    if (selected > 0.8) continue;
    const size = Math.max(part.rect.w, part.rect.h);
    const near = peers.filter(({ part: other }) =>
      neighbouringLetter(part, other, size),
    );
    if (near.length < 2) continue;
    const filled = fillEnclosedMaskHoles(part.data, part.rect.w, part.rect.h);
    const data = projectWindowMask({ bounds: part.rect, data: filled }, edge);
    const radius = Math.max(2, Math.min(4.6, 0.16 * size));
    mask = unionWindowMasks(mask, {
      bounds: { ...edge, x: bounds.x + edge.x, y: bounds.y + edge.y },
      data: Uint8Array.from(distanceToMask(data, edge.w, edge.h), (d) =>
        Number(d <= radius),
      ),
    });
  }
  return mask;
}
