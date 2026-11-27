import type { PixelRect } from "./maskGeometry";
import { printMaskGrid } from "./qwenPrintedPigment";
import { soundStencilWindow } from "./qwenRuledPaper";

/** A series title printed in the top margin can fill nearly the entire
 * detector window. The two lines of type and the untouched rule beneath them
 * supply independent evidence that the stock behind the letters is paper. */
export function restoreRuledHeader(
  source: Buffer,
  selection: Uint8Array,
  width: number,
  height: number,
) {
  if (!selection.subarray(0, width).some(Boolean)) return;
  const window = soundStencilWindow(
    source,
    selection,
    { width, height },
    0,
    (bounds) => headerFits(bounds, width, height),
  );
  if (!window) return;
  const {
    gray,
    box: { x, w, h },
  } = window;
  const at = (u: number, v: number) => v * width + x + u;
  if (!hasPanelRule(source, w, h, at)) return;
  const ink = gray.map((level) => Number(level < 181));
  const rows = printedRows(ink, w, h);
  if (!pairedTitle(rows, h)) return;
  for (const row of rows) {
    const band = ink.subarray(row.start * w, row.end * w);
    if (
      !ownedLetterRow(
        band,
        w,
        row.end - row.start,
        (u, v) => selection[at(u, v + row.start)],
      )
    )
      return;
  }
  const distance = printMaskGrid(w, h).distance(ink);
  if (!whiteHeaderStock(source, gray, distance, w, h, at)) return;
  const result = Buffer.from(source);
  for (let i = 0; i < (h - 2) * w; i++) {
    if (distance[i] > 6) continue;
    const p = 4 * at(i % w, Math.floor(i / w));
    result.fill(255, p, p + 3);
  }
  return result;
}

function headerFits({ x, y, w, h }: PixelRect, width: number, height: number) {
  return (
    y === 0 &&
    h >= 40 &&
    h <= 130 &&
    w >= 280 &&
    w <= 1000 &&
    w >= 3.4 * h &&
    x >= 6 &&
    x + w + 8 <= width &&
    h + 3 <= height
  );
}

type PixelIndex = (x: number, y: number) => number;
function hasPanelRule(source: Buffer, w: number, h: number, at: PixelIndex) {
  // The panel rule must continue past the title. Never include the rule or
  // its antialiased shoulder in the replacement.
  for (let v = h; v < h + 2; v++) {
    for (let u = Math.ceil(0.035 * w); u < w + 8; u++)
      if (source[4 * at(u, v) + 1] >= 100) return false;
  }
  for (let v = 0; v < h - 2; v++) {
    for (const u of [-5, -3, -1, w, w + 2, w + 4])
      if (source[4 * at(u, v) + 1] < 245) return false;
  }
  return true;
}

type PrintedRow = { start: number; end: number };
function pairedTitle(rows: PrintedRow[], h: number) {
  if (rows.length !== 2) return false;
  const [title, subtitle] = rows;
  const em = title.end - title.start,
    small = subtitle.end - subtitle.start;
  return (
    title.start >= 3 &&
    em >= h * 0.28 &&
    subtitle.start - title.end >= 4 &&
    subtitle.end <= h - 4 &&
    small >= em * 0.32 &&
    small <= em * 0.88
  );
}

function whiteHeaderStock(
  source: Buffer,
  gray: Uint8Array,
  distance: Float32Array,
  w: number,
  h: number,
  at: PixelIndex,
) {
  let bank = 0,
    bright = 0,
    white = 0;
  for (let i = 0; i < (h - 2) * w; i++) {
    const p = 4 * at(i % w, Math.floor(i / w));
    if (
      source[p] !== source[p + 1] ||
      source[p] !== source[p + 2] ||
      source[p + 3] !== 255
    )
      return false;
    if (distance[i] <= 6) continue;
    if (gray[i] < 238) return false;
    bank++;
    bright += Number(gray[i] >= 248);
    white += Number(gray[i] === 255);
  }
  return bank >= w * 4 && bright >= 0.99 * bank && white >= 0.78 * bank;
}

function printedRows(ink: Uint8Array, w: number, h: number) {
  const rows: PrintedRow[] = [];
  for (let v = 0; v < h; v++) {
    if (!ink.subarray(v * w, (v + 1) * w).some(Boolean)) continue;
    const row = rows.at(-1);
    if (row?.end === v) row.end++;
    else rows.push({ start: v, end: v + 1 });
  }
  return rows;
}

function ownedLetterRow(
  band: Uint8Array,
  w: number,
  h: number,
  selected: (x: number, y: number) => number,
) {
  const parts = printMaskGrid(w, h).components(band, 1);
  let body = 0,
    total = 0,
    left = w,
    right = 0;
  for (const { rect, area, data } of parts) {
    if (rect.w > 2.15 * h || rect.x < 3 || rect.x + rect.w > w - 3)
      return false;
    let hits = 0;
    data.forEach((on, i) => {
      if (
        on &&
        selected(rect.x + (i % rect.w), rect.y + Math.floor(i / rect.w))
      )
        hits++;
    });
    if (!hits || hits < 0.92 * area) return false;
    body += Number(
      rect.h >= h * 0.59 && rect.y + rect.h >= h * 0.87 && rect.w >= h * 0.16,
    );
    total += area;
    left = Math.min(left, rect.x);
    right = Math.max(right, rect.x + rect.w);
  }
  return (
    body >= 5 &&
    right - left >= 0.8 * w &&
    total > 0.13 * w * h &&
    total < 0.57 * w * h
  );
}
