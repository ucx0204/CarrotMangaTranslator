import type { PixelRect } from "./maskGeometry";
import type { BrushFace, BrushField } from "./qwenSoundRim";
import { retainTerminalPanelRule } from "./qwenSoundRim";
import { printMaskGrid } from "./qwenPrintedPigment";
import { smoothPrintTone } from "./qwenPrintTone";

const directions = Array.from({ length: 24 }, (_, i) => {
  const angle = (Math.PI * i) / 12;
  return { dx: Math.cos(angle), dy: Math.sin(angle) };
});
const profiles = [-0.95, 0, 0.95].flatMap((shift) =>
  [2.7, 3.7].map((width) => ({ shift, width })),
);

/** At a panel boundary the last brush stroke can touch the rule. A connected
 * component then includes both the artwork and the letter. Keep the detector's
 * own ink when several faces independently carry the same narrow white rim. */
export function ruledBrushKeyline(field: BrushField) {
  const { owned, tone, width, height } = field;
  const core = owned.map((set, i) => Number(!!set && tone[i] < 140));
  const retained = new Uint8Array(owned.length).fill(1);
  if (!retainTerminalPanelRule(field, core, retained, 4)) return;
  const grid = printMaskGrid(width, height);
  const distance = grid.distance(core);
  const faces = grid.components(owned, 75);
  if (faces.length < 3) return;
  for (const { rect, data, area } of faces) {
    let ink = 0,
      nearby = 0;
    data.forEach((set, i) => {
      if (!set) return;
      const p =
        (rect.y + Math.floor(i / rect.w)) * width + rect.x + (i % rect.w);
      ink += core[p];
      nearby += Number(distance[p] <= 3.7);
    });
    if (ink < area * 0.5 || nearby < area * 0.9) return;
  }
  if (!hasSharedWhiteRim(tone, distance)) return;
  const matte = Uint8Array.from(distance, (d, i) =>
    Number(!!retained[i] && (d <= 3.6 || (d <= 4.9 && tone[i] >= 201))),
  );
  return { matte, composite: matte, measuredBrush: true as const };
}

function hasSharedWhiteRim(tone: Uint8Array, distance: Float32Array) {
  const total = [0, 0],
    pale = [0, 0];
  distance.forEach((d, i) => {
    if (d < 1.7 || d > 7.4 || (d > 3.4 && d < 4.5)) return;
    const band = Number(d >= 4.5);
    total[band]++;
    pale[band] += Number(tone[i] >= 225);
  });
  const inside = pale[0] / Math.max(1, total[0]);
  const outside = pale[1] / Math.max(1, total[1]);
  return total[0] >= 150 && inside > 0.91 && inside - outside > 0.095;
}

/** Follow the original pen out of a printed keyline. A dark halftone dot or
 * the edge of the plate itself lacks two lighter banks along the entire line. */
export function stockCrossingPen(gray: Uint8Array, bounds: PixelRect) {
  const tone = smoothPrintTone(Float32Array.from(gray), bounds, "fine-pen");
  function sample(x: number, y: number) {
    const left = Math.floor(x),
      top = Math.floor(y);
    const fx = x - left,
      fy = y - top,
      i = top * bounds.w + left;
    return (
      (1 - fy) * (tone[i] + fx * (tone[i + 1] - tone[i])) +
      fy *
        (tone[i + bounds.w] +
          fx * (tone[i + bounds.w + 1] - tone[i + bounds.w]))
    );
  }
  function crossed(
    x: number,
    y: number,
    dx: number,
    dy: number,
    width: number,
    raw: number,
  ) {
    const contrasts: number[] = [],
      centers: number[] = [],
      banks: number[] = [];
    for (let t = 0; t <= 10; t += 2) {
      const cx = x + t * dx,
        cy = y + t * dy;
      const middle = sample(cx, cy);
      const lo = sample(cx - width * dy, cy + width * dx);
      const hi = sample(cx + width * dy, cy - width * dx);
      const contrast = Math.min(lo, hi) - middle;
      if ((t === 0 || t === 4) && contrast < 13) return false;
      contrasts.push(contrast);
      centers.push(middle);
      banks.push(Math.max(lo, hi));
    }
    const first = centers.slice(0, 5);
    return (
      contrasts.filter((contrast) => contrast > 19).length >= 5 &&
      contrasts.slice(1).filter((contrast) => contrast >= 26).length >= 3 &&
      banks.slice(2, 5).filter((level) => level + 5 >= raw).length >= 2 &&
      Math.max(...first) - Math.min(...first) < 60
    );
  }
  return (x: number, y: number, ox: number, oy: number) => {
    const i = y * bounds.w + x;
    if (
      tone[i] > 142 ||
      x < 15 ||
      y < 15 ||
      x >= bounds.w - 15 ||
      y >= bounds.h - 15
    )
      return false;
    const length = Math.hypot(ox, oy);
    for (const { dx, dy } of directions) {
      if (dx * ox + dy * oy < 0.45 * length) continue;
      if (
        profiles.some(({ shift, width }) =>
          crossed(x - shift * dy, y + shift * dx, dx, dy, width, gray[i]),
        )
      )
        return true;
    }
    return false;
  };
}

function thinPrintedRim(field: BrushField, face: BrushFace) {
  const { x, y, w, h } = face.part.rect;
  const stride = w + 14;
  const local = new Uint8Array(stride * (h + 14));
  for (let row = 0; row < h; row++)
    local.set(
      face.part.data.subarray(row * w, (row + 1) * w),
      (row + 7) * stride + 7,
    );
  const radius = printMaskGrid(stride, h + 14).distance(local);
  const white = [0, 0],
    count = [0, 0];
  for (let i = 0; i < radius.length; i++) {
    const d = radius[i];
    if (d < 1.1 || d > 5.5 || (d > 2.3 && d <= 3.5)) continue;
    const col = x + (i % stride) - 7,
      row = y + Math.floor(i / stride) - 7;
    if (Math.min(col, row, field.width - 1 - col, field.height - 1 - row) < 0)
      continue;
    const ring = Number(d > 3.5);
    count[ring]++;
    white[ring] += Number(field.tone[row * field.width + col] >= 234);
  }
  return (
    white[0] >= 0.91 * count[0] && white[1] <= 0.52 * count[1] && count[0] >= 53
  );
}

/** Separate dry, black impact type from the high-contrast drawing between its
 * strokes using the narrow, consistent white keyline around each face. */
export function thinOutlinedImpact(field: BrushField, candidates: BrushFace[]) {
  const heavy = candidates.filter(
    (f) => f.part.area >= 420 && f.thick >= 5.5 && f.dark > 0.86,
  );
  const owned = heavy.filter((f) => f.overlap >= 0.8);
  if (
    !owned.some((f) => f.part.area > 6500) ||
    owned.filter((f) => f.part.area >= 1500).length < 3
  )
    return;
  const matched = heavy.filter((f) => thinPrintedRim(field, f));
  const anchors = matched.filter((f) => f.overlap >= 0.8);
  if (anchors.length < 4 || !anchors.some((f) => f.part.area > 6500)) return;
  const core = new Uint8Array(field.owned.length);
  const mark = (face: BrushFace) => {
    for (const p of face.positions) core[p] = 1;
  };
  for (const f of anchors) mark(f);
  const distance = printMaskGrid(field.width, field.height).distance(core);
  for (const face of matched) {
    if (face.overlap >= 0.8 || face.part.area > 2500 || face.overlap <= 0.01)
      continue;
    if (
      face.positions.some((p) => distance[p] <= Math.min(32, 2.8 * face.thick))
    )
      mark(face);
  }
  const matte = Uint8Array.from(
    printMaskGrid(field.width, field.height).distance(core),
    (d) => Number(d <= 4.4),
  );
  return { matte, composite: matte, measuredBrush: "solid-impact" as const };
}
