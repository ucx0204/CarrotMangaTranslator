import { soundStencilWindow } from "./qwenRuledPaper";

type Size = { width: number; height: number };
type Window = NonNullable<ReturnType<typeof soundStencilWindow>>;

const radius = 6;
const support = Array.from({ length: 49 }, (_, index) => {
  const x = (index % 7) * 2 - radius,
    y = Math.floor(index / 7) * 2 - radius;
  return { x, y, weight: Math.exp((-0.9 * (x * x + y * y)) / radius ** 2) };
});

/** Recover fine flecks from the same rock face when the native Qwen decoder
 * leaves smooth shading inside the former letters. The decoded drawing guides
 * patch selection, and only intact original pixels may supply the print. */
export function restoreStoneTexture(
  source: Buffer,
  decoded: Buffer,
  stencil: Uint8Array,
  size: Size,
) {
  const window = soundStencilWindow(source, stencil, size, 72, () => true);
  if (!window) return decoded;
  const { box, gray, distance } = window;
  const global = (i: number) =>
    4 * ((box.y + Math.floor(i / box.w)) * size.width + box.x + (i % box.w));
  const unfilled = distance.map((d) => Number(d <= 4.1));
  const known = Uint8Array.from(unfilled, (v) => Number(!v));
  const values = Float32Array.from(gray, (v, i) =>
    known[i] ? v : decoded[global(i) + 1],
  );
  const samples = stoneDonors(window);
  if (!samples.length) return decoded;
  const result = Buffer.from(source);
  const missing = Array.from(unfilled.keys()).filter((i) => !known[i]);
  const priority = new Float32Array(gray.length).fill(-1);
  const field = { known, values, w: box.w, h: box.h };
  let next;
  while ((next = nextStonePatch(missing, field, priority)) !== undefined) {
    const donor = matchStoneDonor(next, samples, field, gray, unfilled);
    if (donor === undefined) return decoded;
    pasteStonePatch(next, donor, field, priority, (at, from) => {
      const dst = global(at),
        src = global(from);
      result[dst] = source[src];
      result[dst + 1] = source[src + 1];
      result[dst + 2] = source[src + 2];
    });
  }
  return result;
}

function stoneDonors({ box, distance }: Window) {
  const samples: number[] = [];
  for (let y = radius; y < box.h - radius; y++)
    for (let x = radius; x < box.w - radius; x++) {
      const i = y * box.w + x;
      if (distance[i] > radius + 6 && distance[i] < 59) samples.push(i);
    }
  return samples;
}

type Field = { known: Uint8Array; values: Float32Array; w: number; h: number };
function nextStonePatch(
  missing: number[],
  field: Field,
  priority: Float32Array,
) {
  const { known, w } = field;
  let best: number | undefined,
    score = -1;
  for (const i of missing) {
    if (
      known[i] ||
      !(known[i - 1] || known[i + 1] || known[i - w] || known[i + w])
    )
      continue;
    if (priority[i] < 0) priority[i] = stoneBoundaryPriority(i, field);
    if (priority[i] > score) {
      best = i;
      score = priority[i];
    }
  }
  return best;
}
const bell = Array.from({ length: 25 }, (_, v) =>
  Math.exp(-((v - 12) ** 2) / (2 * (radius * 0.54) ** 2)),
);
const totalWeight = bell.reduce((a, b) => a + b, 0) ** 2;
function stoneBoundaryPriority(at: number, { known, values, w, h }: Field) {
  const px = at % w,
    py = Math.floor(at / w);
  let count = 0,
    power = 0;
  for (let y = Math.max(0, py - 12); y <= Math.min(h - 1, py + 12); y++) {
    for (let x = Math.max(0, px - 12); x <= Math.min(w - 1, px + 12); x++) {
      const i = y * w + x;
      if (!known[i]) continue;
      const weight = bell[x - px + 12] * bell[y - py + 12];
      count += weight;
      power += weight * (255 - values[i]) ** 2;
    }
  }
  return (
    count / totalWeight +
    0.006 * Math.min(100, Math.sqrt(power / (count + 0.001)))
  );
}

function matchStoneDonor(
  target: number,
  donors: number[],
  field: Field,
  gray: Uint8Array,
  holes: Float32Array,
) {
  const { w, h, known, values } = field,
    px = target % w,
    py = Math.floor(target / w);
  const measured = support.map(({ x, y, weight }) => {
    const at =
      Math.min(h - 1, Math.max(0, py + y)) * w +
      Math.min(w - 1, Math.max(0, px + x));
    return {
      delta: y * w + x,
      level: values[at],
      weight: weight * (0.04 + 0.45 * known[at] + 1.6 * Number(!holes[at])),
    };
  });
  const weight = measured.reduce((sum, v) => sum + v.weight, 0);
  let best: number | undefined,
    score = Infinity;
  for (const i of donors) {
    const distance = Math.hypot((i % w) - px, Math.floor(i / w) - py);
    if (distance >= 64) continue;
    let error = 0.025 * distance * weight;
    for (const probe of measured) {
      error +=
        Math.min(90, Math.abs(gray[i + probe.delta] - probe.level)) *
        probe.weight;
      if (error >= score) break;
    }
    if (error < score) {
      best = i;
      score = error;
    }
  }
  return best;
}

function pasteStonePatch(
  at: number,
  donor: number,
  { w, h, known, values }: Field,
  priority: Float32Array,
  copy: (at: number, from: number) => void,
) {
  const px = at % w,
    py = Math.floor(at / w);
  for (let y = Math.max(0, py - 16); y <= Math.min(h - 1, py + 16); y++) {
    priority.fill(
      -1,
      y * w + Math.max(0, px - 16),
      y * w + Math.min(w, px + 17),
    );
    if (Math.abs(y - py) > 4) continue;
    for (let x = Math.max(0, px - 4); x <= Math.min(w - 1, px + 4); x++) {
      const i = y * w + x;
      if (known[i]) continue;
      const from = donor + i - at;
      known[i] = 1;
      values[i] = values[from];
      copy(i, from);
    }
  }
}
