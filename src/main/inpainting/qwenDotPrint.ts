import { median } from "./qwenSoundRim";

export type ScreenScan = {
  width: number;
  height: number;
  gray: Uint8Array;
  distance: Float32Array;
  mask: Uint8Array;
  source: Buffer;
  offset: (i: number) => number;
};
type Shift = { dx: number; dy: number; cost: number };
type Estimate = { at: number; value: number; weight: number };

function paperTone(scan: ScreenScan, i: number) {
  let sum = 0,
    energy = 0;
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) {
      const level = scan.gray[i + dy * scan.width + dx];
      if (level < 160) return;
      sum += level;
      energy += level * level;
    }
  const mean = sum / 49,
    deviation = Math.sqrt(Math.max(0, energy / 49 - mean * mean));
  if (deviation > 6 && deviation < 28 && mean > 193 && mean < 246) return mean;
}

type DotField = { width: number; levels: ArrayLike<number> };
function repeatScore(
  scan: DotField,
  bank: Uint8Array,
  points: number[],
  dx: number,
  dy: number,
  center: number,
) {
  let cross = 0,
    left = 0,
    right = 0,
    count = 0;
  for (const i of points) {
    const x = (i % scan.width) + dx,
      j = i + dy * scan.width + dx;
    if (x < 0 || x >= scan.width || !bank[j]) continue;
    const a = scan.levels[i] - center,
      b = scan.levels[j] - center;
    cross += a * b;
    left += a * a;
    right += b * b;
    count++;
  }
  return count >= 100 ? cross / Math.sqrt(Math.max(1, left * right)) : 0;
}

/** Find actual whole-pixel repetitions of these dots, allowing for a slightly
 * rotated screen. Longer displacements can supply print inside a wide face. */
export function screenRepeatOffsets(
  scan: DotField,
  bank: Uint8Array,
  positions: number[],
  center: number,
) {
  const stride = Math.max(1, Math.floor(positions.length / 1300)),
    points = positions.filter((_, i) => i % stride === 0);
  const candidates: Shift[] = [];
  const add = (dx: number, dy: number) => {
    const length = Math.hypot(dx, dy);
    if (length < 4.5) return;
    const score = repeatScore(scan, bank, points, dx, dy, center);
    if (score >= 0.76)
      candidates.push({ dx, dy, cost: 7 * (1 - score) + 0.012 * length });
  };
  for (let dy = -22; dy <= 22; dy++)
    for (let dx = -22; dx <= 22; dx++) add(dx, dy);
  for (let d = 23; d <= 76; d++)
    for (const sign of [-1, 1]) {
      add(sign * d, 0);
      add(0, sign * d);
    }
  return candidates.sort((a, b) => a.cost - b.cost).slice(0, 130);
}

export function matchingDot(
  scan: Pick<ScreenScan, "width" | "gray">,
  bank: Uint8Array,
  shifts: Shift[],
  i: number,
  toneCost: (p: number) => number = () => 0,
) {
  const x = i % scan.width,
    samples: Estimate[] = [];
  let reference: number | undefined;
  let best = Infinity,
    total = 0;
  for (const { dx, dy, cost } of shifts) {
    if (cost > best + 1.4) break;
    const j = i + dy * scan.width + dx;
    if (x + dx < 0 || x + dx >= scan.width || !bank[j]) continue;
    const adjusted = cost + toneCost(j);
    best = Math.min(best, adjusted);
    reference ??= cost;
    const weight = Math.exp(-(adjusted - reference) / 0.35);
    samples.push({ at: j, value: scan.gray[j], weight });
    total += weight;
  }
  let mass = 0;
  for (const s of samples.sort((a, b) => a.value - b.value)) {
    mass += s.weight;
    if (mass >= total / 2) return s.at;
  }
}

function validatedRepeats(
  scan: ScreenScan,
  bank: Uint8Array,
  train: number[],
  held: number[],
  center: number,
) {
  const shifts = screenRepeatOffsets(
    { width: scan.width, levels: scan.gray },
    bank,
    train,
    center,
  );
  let count = 0,
    error = 0,
    cross = 0,
    left = 0,
    right = 0;
  const colorError = [0, 0, 0];
  for (const i of held) {
    const matched = matchingDot(scan, bank, shifts, i);
    if (matched === undefined) continue;
    const a = scan.gray[i] - center,
      b = scan.gray[matched] - center;
    error += Math.abs(a - b);
    for (let c = 0; c < 3; c++)
      colorError[c] += Math.abs(
        scan.source[scan.offset(i) + c] - scan.source[scan.offset(matched) + c],
      );
    cross += a * b;
    left += a * a;
    right += b * b;
    count++;
  }
  if (
    count >= 200 &&
    count >= 0.9 * held.length &&
    error / count <= 6 &&
    Math.max(...colorError) <= 7 * count &&
    cross / Math.sqrt(Math.max(1, left * right)) >= 0.81
  )
    return shifts;
}

export function measuredDotPlate(
  scan: ScreenScan,
  edge: (y: number) => number,
  top: number,
  bottom: number,
) {
  const means = new Float32Array(scan.gray.length),
    positions: number[] = [];
  for (
    let y = Math.max(3, top - 20);
    y <= Math.min(scan.height - 4, bottom + 20);
    y++
  ) {
    const line = edge(y);
    for (
      let x = Math.max(3, Math.ceil(line + 6));
      x <= Math.min(scan.width - 4, line + 115);
      x++
    ) {
      const i = y * scan.width + x;
      if (scan.distance[i] <= 8) continue;
      const mean = paperTone(scan, i);
      if (mean !== undefined) {
        means[i] = mean;
        positions.push(i);
      }
    }
  }
  if (positions.length < 1200) return;
  const center = median(positions.map((i) => means[i]));
  const train: number[] = [],
    held: number[] = [];
  const bank = new Uint8Array(scan.gray.length);
  for (const i of positions) {
    if (Math.abs(means[i] - center) >= 3.5) continue;
    const x = i % scan.width,
      y = Math.floor(i / scan.width);
    if ((Math.floor(x / 12) + Math.floor(y / 10)) % 7 === 1) held.push(i);
    else {
      train.push(i);
      bank[i] = 1;
    }
  }
  const shifts = validatedRepeats(scan, bank, train, held, center);
  if (!shifts) return;
  for (const i of held) bank[i] = 1;
  const background = [0, 1, 2].map((c) =>
    median(train.map((i) => scan.source[scan.offset(i) + c])),
  );
  return {
    background,
    donor: (i: number) => matchingDot(scan, bank, shifts, i),
  };
}
