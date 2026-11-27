import { measuredDotPlate, type ScreenScan } from "./qwenDotPrint";
import { interruptedScreenCurve } from "./qwenScreenCurve";
import { printMaskGrid } from "./qwenPrintedPigment";
import { median } from "./qwenSoundRim";
import { soundStencilWindow } from "./qwenRuledPaper";

export type QwenScreenCrop = {
  original: Buffer;
  stencil: Uint8Array;
  width: number;
  height: number;
};
type Window = NonNullable<ReturnType<typeof soundStencilWindow>>;
type Edge = NonNullable<ReturnType<typeof interruptedScreenCurve>>;
function screenView(
  crop: QwenScreenCrop,
  window: Window,
  mirror: boolean,
): ScreenScan {
  const { box, active } = window,
    swap = active.w < active.h;
  const width = swap ? box.h : box.w,
    height = swap ? box.w : box.h;
  const local = (i: number) => {
    const x = mirror ? width - 1 - (i % width) : i % width,
      y = Math.floor(i / width);
    return swap ? x * box.w + y : y * box.w + x;
  };
  const offset = (i: number) => {
    const p = local(i);
    return (
      4 * ((box.y + Math.floor(p / box.w)) * crop.width + box.x + (p % box.w))
    );
  };
  return {
    width,
    height,
    source: crop.original,
    offset,
    gray: Uint8Array.from(window.gray, (_, i) => window.gray[local(i)]),
    mask: Uint8Array.from(window.local, (_, i) =>
      Number(!!window.local[local(i)]),
    ),
    distance: Float32Array.from(
      window.distance,
      (_, i) => window.distance[local(i)],
    ),
  };
}

function crossedFace(
  scan: ScreenScan,
  edge: Edge,
  top: number,
  bottom: number,
) {
  const grid = printMaskGrid(scan.width, scan.height),
    selected = new Uint8Array(scan.mask.length);
  for (const part of grid.components(scan.mask, 60)) {
    const cells: number[] = [];
    let cross = false,
      dark = 0;
    part.data.forEach((on, j) => {
      if (!on) return;
      const x = part.rect.x + (j % part.rect.w),
        y = part.rect.y + Math.floor(j / part.rect.w),
        i = y * scan.width + x;
      cells.push(i);
      if (y >= top && y <= bottom && Math.abs(edge.line(y) - x) < 3)
        cross = true;
      dark += Number(scan.gray[i] < 120);
    });
    if (cross && dark >= 0.35 * cells.length)
      for (const i of cells) selected[i] = 1;
  }
  if (selected.some(Boolean)) return grid.distance(selected);
}

/** Sample the original outline at subpixel offsets on both exposed banks.
 * Register the source tint and antialiasing against the paper on either side. */
function inkProfile(scan: ScreenScan, edge: Edge, screen: number[]) {
  const points = [...edge.above.slice(-28), ...edge.below.slice(0, 28)];
  const paper = [0, 1, 2].map((c) =>
    median(
      points.map(
        (p) =>
          scan.source[scan.offset(p.y * scan.width + Math.round(p.x) - 7) + c],
      ),
    ),
  );
  const samples = Array.from({ length: 61 }, (_, j) => {
    const d = j / 10 - 3;
    return [0, 1, 2].map((c) =>
      median(
        points.map((p) => {
          const x = p.x + d,
            l = Math.floor(x),
            frac = x - l,
            i = p.y * scan.width + l;
          const v =
            scan.source[scan.offset(i) + c] * (1 - frac) +
            scan.source[scan.offset(i + 1) + c] * frac;
          return Math.max(
            0.01,
            Math.min(1, v / (d >= 0 ? screen[c] : paper[c])),
          );
        }),
      ),
    );
  });
  return {
    paper,
    transmission: (d: number, c: number) => {
      if (d <= -3 || d >= 3) return 1;
      const x = 10 * (d + 3),
        l = Math.floor(x),
        t = x - l;
      return samples[l][c] * (1 - t) + samples[l + 1][c] * t;
    },
  };
}

function screenWasLost(
  distanceFromEdge: number,
  selected: number,
  decoded: number,
  screen: number,
) {
  return (
    distanceFromEdge > 3 && selected !== 0 && Math.abs(decoded - screen) > 9
  );
}

function applyCurve(scan: ScreenScan, edge: Edge) {
  const top = edge.above[edge.above.length - 1].y,
    bottom = edge.below[0].y;
  const zone = crossedFace(scan, edge, top, bottom);
  if (!zone) return;
  const plate = measuredDotPlate(scan, edge.line, top, bottom);
  if (!plate) return;
  const profile = inkProfile(scan, edge, plate.background);
  return (decoded: Buffer) => {
    const out = Buffer.from(decoded);
    let available = 0,
      required = 0,
      blanked = 0;
    for (
      let y = Math.max(0, top - 20);
      y <= Math.min(scan.height - 1, bottom + 20);
      y++
    ) {
      const line = edge.line(y);
      for (let x = Math.max(0, Math.ceil(line - 8)); x < scan.width; x++) {
        const i = y * scan.width + x,
          d = x - line;
        if (zone[i] >= 5.7) continue;
        const p = scan.offset(i),
          j = d > 0 ? plate.donor(i) : undefined;
        required++;
        if (d > 0 && j === undefined) continue;
        available++;
        for (let c = 0; c < 3; c++) {
          const bg =
            j === undefined
              ? profile.paper[c]
              : scan.source[scan.offset(j) + c];
          out[p + c] = Math.round(bg * profile.transmission(d, c));
        }
        blanked += Number(
          screenWasLost(d, scan.mask[i], decoded[p + 1], out[p + 1]),
        );
      }
    }
    if (available >= 0.96 * required && blanked >= 60) return out;
  };
}

export function measuredCurvedDotStock(crop: QwenScreenCrop) {
  const window = soundStencilWindow(
    crop.original,
    crop.stencil,
    crop,
    90,
    ({ w, h }) => {
      const long = Math.max(w, h),
        short = Math.min(w, h);
      return short >= 22 && long >= 90 && long <= 520 && long > 1.5 * short;
    },
  );
  if (!window) return;
  for (const mirror of [false, true]) {
    const view = screenView(crop, window, mirror),
      edge = interruptedScreenCurve(view);
    if (!edge) continue;
    const repaired = applyCurve(view, edge);
    if (repaired) return repaired;
  }
}
