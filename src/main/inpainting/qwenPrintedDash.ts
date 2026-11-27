import type { PixelRect } from "./maskGeometry";

type Stop = { cx: number; cy: number; rect: PixelRect };
type Print = { tone: Uint8Array; w: number; h: number; selection: PixelRect };

function sample(field: Print, x: number, y: number) {
  if (y < 0 || y >= field.h - 1) return 255;
  const row = Math.floor(y),
    f = y - row,
    i = row * field.w + x;
  return (1 - f) * field.tone[i] + f * field.tone[i + field.w];
}

type Dash = { x: number; end: number; y: number; slope: number; score: number };
function endsAtStop(
  length: number,
  good: number,
  gap: number,
  a: Stop,
  w: number,
) {
  return (
    length >= 0.18 * w &&
    good > 0.82 * length &&
    gap > 0.5 * a.rect.w &&
    gap < 2.5 * a.rect.w
  );
}
function bracketedRun(
  field: Print,
  a: Stop,
  slope: number,
  offset: number,
): Dash | undefined {
  const first = Math.max(0, Math.round(a.cx - 0.59 * field.selection.w));
  const last = Math.min(field.w - 1, Math.round(a.cx - 0.55 * a.rect.w));
  let start = first,
    good = 0,
    strength = 0,
    gap = 0,
    best: Dash | undefined;
  const axis = (x: number) => a.cy + offset + (x - a.cx) * slope;
  for (let x = first; x <= last + 2; x++) {
    const y = axis(x),
      middle = sample(field, Math.min(x, last), y);
    const high = sample(field, Math.min(x, last), y - 1.85),
      low = sample(field, Math.min(x, last), y + 1.85);
    if (
      x <= last &&
      middle > 124 &&
      middle - Math.max(high, low) > 38 &&
      Math.min(high, low) < 98
    ) {
      if (!good) start = x;
      good++;
      gap = 0;
      strength += Math.min(1, (middle - Math.max(high, low)) / 175);
      continue;
    }
    if (++gap < 2) continue;
    const end = x - gap,
      length = end - start + 1;
    if (
      endsAtStop(length, good, a.cx - end, a, field.selection.w) &&
      strength > (best?.score ?? 0)
    )
      best = { x: start, end, y: axis(start), slope, score: strength };
    good = 0;
    strength = 0;
  }
  return best;
}

export function addBracketedRule(
  field: Print,
  data: Uint8Array,
  a: Stop,
  b: Stop,
) {
  const slope = (b.cy - a.cy) / (b.cx - a.cx);
  let best: Dash | undefined;
  for (let delta = -0.043; delta <= 0.0431; delta += 0.003)
    for (let y = -2.08 * a.rect.h; y < -0.54 * a.rect.h; y += 0.34) {
      const hit = bracketedRun(field, a, slope + delta, y);
      if (hit && hit.score > (best?.score ?? 0)) best = hit;
    }
  if (!best) return;
  for (
    let x = Math.max(0, best.x - 2);
    x <= Math.min(field.w - 1, best.end + 2);
    x++
  ) {
    const center = best.y + (x - best.x) * best.slope;
    for (
      let y = Math.max(0, Math.ceil(center - 3.25));
      y <= Math.min(field.h - 1, Math.floor(center + 3.25));
      y++
    )
      data[y * field.w + x] = 1;
  }
}
