import type { maskComponents } from "./rasterMasks";
import type { PixelRect } from "./maskGeometry";
import { isExclamationPair } from "./qwenBalloonPaper";

type Ink = ReturnType<typeof maskComponents>[number];
type Mark = {
  part: Ink;
  x: number;
  y: number;
  removed: boolean;
  selected: number;
};

/** A tight Japanese text mask can leave a reading between two main columns,
 * or select only the last dot of a typeset vertical ellipsis. Require the
 * other native strokes of the same line and an actually removed neighbour. */
export function missingBalloonReadings(
  original: Buffer,
  restored: Buffer,
  components: Ink[],
  stencil: Uint8Array,
  width: number,
  height: number,
) {
  const marks: Mark[] = [];
  for (const part of components) {
    const { x, y, w, h } = part.rect;
    if (w > 52 || h > 55 || !x || !y || x + w >= width || y + h >= height)
      continue;
    let selected = 0,
      erased = 0;
    part.data.forEach((v, i) => {
      if (!v) return;
      const j = (y + Math.floor(i / w)) * width + x + (i % w);
      selected += Number(!!stencil[j]);
      erased += Number(
        restored[4 * j + 1] >= 245 &&
          restored[4 * j + 1] > original[4 * j + 1] + 20,
      );
    });
    marks.push({
      part,
      selected,
      x: x + w / 2,
      y: y + h / 2,
      removed: erased > 0.92 * part.area,
    });
  }
  const main = marks.filter(
    ({ part, removed, selected }) =>
      removed &&
      selected > 0 &&
      part.area >= 20 &&
      part.rect.w >= 7 &&
      part.rect.h >= 8,
  );
  if (main.length < 3) return [];
  const dots = marks.filter(({ part }) => isRoundPrintDot(part));
  const endings = selectedExclamationEndings(marks, dots, main);
  return marks
    .filter(
      (mark) =>
        !mark.removed &&
        (endings.has(mark) ||
          readingBetweenColumns(mark, main) ||
          (isRoundPrintDot(mark.part) && completedEllipsis(mark, dots, main))),
    )
    .map(({ part }) => part);
}

/** A tightly traced exclamation may select just one flank of both pieces.
 * Require the paired native ink and a completed glyph immediately above it. */
function selectedExclamationEndings(marks: Mark[], dots: Mark[], main: Mark[]) {
  const endings = new Set<Mark>();
  const owned = (mark: Mark) => mark.selected >= 0.3 * mark.part.area;
  for (const dot of dots.filter(owned)) {
    for (const stem of marks) {
      if (!owned(stem) || !isExclamationPair(stem.part, dot.part)) continue;
      const top = stem.part.rect.y;
      const followsLetter = main.some(({ x, part: { rect } }) => {
        const gap = top - rect.y - rect.h;
        return (
          gap >= 0 &&
          gap <= 1.2 * stem.part.rect.h &&
          Math.abs(stem.x - x) <= 0.48 * rect.w
        );
      });
      if (followsLetter) {
        endings.add(stem);
        endings.add(dot);
      }
    }
  }
  return endings;
}

function readingBetweenColumns(mark: Mark, main: Mark[]) {
  const { w, h } = mark.part.rect;
  if (
    !mark.selected ||
    w < 4 ||
    h < 4 ||
    w > 11 ||
    h > 12 ||
    mark.part.area > 0.85 * w * h
  )
    return false;
  const sameRow = main.filter((p) => {
    const r = p.part.rect;
    return (
      r.h >= 1.68 * h &&
      r.w >= 1.62 * w &&
      Math.abs(p.y - mark.y) <= 0.32 * r.h &&
      Math.abs(p.x - mark.x) >= 0.45 * r.w &&
      Math.abs(p.x - mark.x) <= 0.95 * r.w
    );
  });
  return sameRow.some((p) => p.x < mark.x) && sameRow.some((p) => p.x > mark.x);
}

function isRoundPrintDot(part: Ink) {
  const { w, h } = part.rect,
    span = Math.max(w, h);
  return (
    span >= 2 &&
    span <= 9 &&
    Math.min(w, h) >= 0.73 * span &&
    part.area >= 0.53 * w * h
  );
}

function sameDot(a: Mark, b: Mark) {
  return (
    Math.abs(a.x - b.x) <= 1.25 &&
    Math.abs(a.part.rect.w - b.part.rect.w) <= 1 &&
    Math.abs(a.part.rect.h - b.part.rect.h) <= 1 &&
    Math.abs(a.part.area - b.part.area) <= 0.32 * a.part.area
  );
}

function completedEllipsis(mark: Mark, dots: Mark[], main: Mark[]) {
  const size = mark.part.rect.h;
  const peers = dots
    .filter((p) => Math.abs(p.y - mark.y) <= 7.2 * size && sameDot(mark, p))
    .sort((a, b) => a.y - b.y);
  for (let i = 0; i + 2 < peers.length; i++) {
    const line = peers.slice(i, i + 3),
      [first, mid, last] = line,
      pitch = mid.y - first.y;
    if (
      !line.includes(mark) ||
      !line.some((v) => v.removed && v.selected) ||
      pitch < 1.35 * size ||
      pitch > 3.6 * size ||
      Math.abs(last.y - mid.y - pitch) > 1.25
    )
      continue;
    const sameColumn = main.filter(
      (p) => Math.abs(p.x - mark.x) <= Math.max(size, 0.42 * p.part.rect.w),
    );
    if (
      sameColumn.some((p) => nearEnd(p.part.rect, first.y, pitch, true)) &&
      sameColumn.some((p) => nearEnd(p.part.rect, last.y, pitch, false))
    )
      return true;
  }
  return false;
}

function nearEnd(
  box: PixelRect,
  center: number,
  pitch: number,
  above: boolean,
) {
  const gap = above ? center - box.y - box.h : box.y - center;
  return gap >= 0 && gap <= 1.9 * pitch;
}
