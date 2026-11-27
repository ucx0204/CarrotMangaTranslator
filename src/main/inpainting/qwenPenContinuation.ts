import { median } from "./qwenSoundRim";
type Scan = {
  source: Buffer;
  out: Buffer;
  gray: Uint8Array;
  distance: Float32Array;
  offset: (i: number) => number;
  width: number;
  height: number;
};
type Sample = {
  x: number;
  y: number;
  sigma: number;
  mass: number;
  shade: number[];
};
type Tip = Sample & { slope: number; start: boolean; run: Sample[] };

const solidPen = {
  threshold: 205,
  clearance: 2.8,
  peak: 69,
  join: 1.8,
  pale: false,
};
const fadingPen = {
  threshold: 245,
  clearance: 1.25,
  peak: 11,
  join: 1.6,
  pale: true,
};
type PenProfile = typeof solidPen;
type Index = (x: number, y: number) => number;
type Gap = { left: Tip; right: Tip; path: number[] };

/** Follow native pen on both sides of a knockout. Bridge only mutually facing
 * ends whose width, tangent and contrast were measured on clean scanlines. */
export function continueQwenPen(scan: Scan) {
  continueAlong(scan, false);
  continueAlong(scan, true);
}

function continueAlong(scan: Scan, transpose: boolean) {
  const cols = transpose ? scan.height : scan.width;
  const rows = transpose ? scan.width : scan.height;
  const index = (x: number, y: number) =>
    transpose ? x * scan.width + y : y * scan.width + x;
  const runs = scanRuns(scan, cols, rows, index, solidPen);
  const tips = runs.flatMap((run) =>
    [false, true].flatMap((start) => fitTip(scan, index, run, start) ?? []),
  );
  const pairs: Gap[] = [];
  for (const left of tips.filter((v) => !v.start)) {
    for (const right of tips.filter((v) => v.start)) {
      const gap = matchEnds(scan, index, rows, left, right);
      if (gap) pairs.push(gap);
    }
  }
  const used = new Set<Tip>();
  for (const gap of pairs.sort((a, b) => a.path.length - b.path.length)) {
    if (used.has(gap.left) || used.has(gap.right)) continue;
    used.add(gap.left);
    used.add(gap.right);
    drawGap(scan, index, rows, gap);
  }
  continueFadingAlong(scan, rows, cols, index);
}

function matchEnds(
  scan: Scan,
  index: Index,
  rows: number,
  left: Tip,
  right: Tip,
) {
  const span = right.x - left.x;
  if (span < 3 || span > 34 || left.run === right.run) return;
  const slope = (right.y - left.y) / span;
  if (
    Math.max(Math.abs(left.slope - slope), Math.abs(right.slope - slope)) >
      Math.max(0.13, 1.45 / span) ||
    Math.abs(left.slope - right.slope) > 0.48 ||
    Math.max(left.mass, right.mass) > 2.35 * Math.min(left.mass, right.mass)
  )
    return;
  const path = Array.from({ length: span - 1 }, (_, n) => {
    const s = (n + 1) / span,
      v = 1 - s;
    return (
      (1 + 2 * s) * v * v * left.y +
      s * v * v * span * left.slope +
      s * s * (3 - 2 * s) * right.y -
      s * s * v * span * right.slope
    );
  });
  if (path.some((y) => y < 3 || y >= rows - 4)) return;
  const close = path.filter(
    // The eight-neighbour distance can exceed Euclidean distance by 8.24%.
    (y, n) => scan.distance[index(left.x + n + 1, Math.round(y))] < 9 * 1.083,
  );
  if (close.length >= 0.7 * path.length) return { left, right, path };
}

function drawGap(
  scan: Scan,
  index: Index,
  rows: number,
  { left, right, path }: Gap,
) {
  const shoulder = [
    left.y - left.slope,
    left.y,
    ...path,
    right.y,
    right.y + right.slope,
  ];
  shoulder.forEach((y, n) => {
    const x = left.x + n - 1;
    // Letter keylines taper an original pen stroke before its skeleton ends.
    // Recover those faded endpoint samples using the intact native flank.
    const s = Math.max(0, Math.min(1, (x - left.x) / (right.x - left.x)));
    const mass = (1 - s) * left.mass + s * right.mass;
    const shade = left.shade.map((v, c) => (1 - s) * v + s * right.shade[c]);
    const ink = Math.max(
      1,
      255 - (29 * shade[0] + 150 * shade[1] + 77 * shade[2]) / 256,
    );
    const sigma = Math.max(
      (1 - s) * left.sigma + s * right.sigma,
      mass / (2.5066 * ink),
    );
    for (
      let j = Math.max(0, Math.floor(y) - 3);
      j <= Math.min(rows - 1, Math.floor(y) + 4);
      j++
    ) {
      const i = index(x, j);
      if (scan.distance[i] > 15) continue;
      const density = Math.min(
        ink,
        (mass / (2.5066 * sigma)) * Math.exp(-0.5 * ((j - y) / sigma) ** 2),
      );
      const p = scan.offset(i);
      for (let c = 0; c < 3; c++)
        scan.out[p + c] = Math.min(
          scan.out[p + c],
          Math.max(0, Math.round(255 - (density * (255 - shade[c])) / ink)),
        );
    }
  });
}

function scanRuns(
  scan: Scan,
  cols: number,
  rows: number,
  index: Index,
  profile: PenProfile,
) {
  const runs: Sample[][] = [];
  let previous: Sample[][] = [];
  for (let x = 0; x < cols; x++) {
    const ends = previous.map((run) => ({ run, y: run[run.length - 1].y }));
    const current: Sample[][] = [];
    for (const sample of columnSamples(scan, x, rows, index, profile)) {
      const parents = ends.filter(
        (end) => Math.abs(end.y - sample.y) < profile.join,
      );
      const parent = parents.length === 1 ? parents[0].run : undefined;
      if (parent && !current.includes(parent)) {
        parent.push(sample);
        current.push(parent);
      } else {
        const run = [sample];
        runs.push(run);
        current.push(run);
      }
    }
    previous = current;
  }
  return runs.filter((run) => run.length >= 6);
}

function columnSamples(
  scan: Scan,
  x: number,
  rows: number,
  index: Index,
  profile: PenProfile,
) {
  const samples: Sample[] = [];
  let y = 0;
  const isInk = (v: number) =>
    scan.gray[index(x, v)] < profile.threshold &&
    scan.distance[index(x, v)] > profile.clearance;
  while (y < rows) {
    if (!isInk(y)) {
      y++;
      continue;
    }
    const first = y;
    while (y < rows && isInk(y)) y++;
    if (y - first > 4 || first < 3 || y > rows - 3) continue;
    if (
      profile.pale &&
      ![first - 3, first - 2, y + 1, y + 2].every(
        (v) => scan.gray[index(x, v)] >= 246,
      )
    )
      continue;
    const sample = measureSection(scan, index, x, first, y, profile.peak);
    if (sample) samples.push(sample);
  }
  return samples;
}

function measureSection(
  scan: Scan,
  index: Index,
  x: number,
  first: number,
  y: number,
  minimumPeak: number,
) {
  let mass = 0,
    sum = 0,
    sum2 = 0,
    peak = 0;
  for (let j = first - 1; j <= y; j++) {
    const ink = Math.max(0, 253 - scan.gray[index(x, j)]);
    mass += ink;
    sum += ink * j;
    sum2 += ink * j * j;
    peak = Math.max(peak, ink);
  }
  if (peak < minimumPeak) return;
  const center = sum / mass,
    p = scan.offset(index(x, Math.round(center)));
  const sigma = Math.max(
    0.38,
    Math.min(1.35, Math.sqrt(Math.max(0, sum2 / mass - center ** 2))),
  );
  return {
    x,
    y: center,
    mass,
    sigma,
    shade: [scan.source[p], scan.source[p + 1], scan.source[p + 2]],
  };
}

function fitTip(scan: Scan, index: Index, run: Sample[], start: boolean) {
  const end = run[start ? 0 : run.length - 1];
  if (scan.distance[index(end.x, Math.round(end.y))] > 14) return;
  const points = start ? run.slice(0, 10) : run.slice(-10);
  const meanX = (points[0].x + points[points.length - 1].x) / 2;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  const slope =
    points.reduce((sum, p) => sum + (p.x - meanX) * (p.y - meanY), 0) /
    points.reduce((sum, p) => sum + (p.x - meanX) ** 2, 0);
  const residual = points
    .map((p) => Math.abs(meanY + slope * (p.x - meanX) - p.y))
    .sort((a, b) => a - b);
  const mass = median(points.map((p) => p.mass));
  if (
    Math.abs(slope) > 0.83 ||
    residual[Math.floor(0.8 * (residual.length - 1))] > 0.44 ||
    mass <= 60 ||
    mass >= 645
  )
    return;
  return {
    ...end,
    mass,
    start,
    run,
    slope,
    sigma: median(points.map((p) => p.sigma)),
    shade: [0, 1, 2].map((c) => median(points.map((p) => p.shade[c]))),
  };
}

type FadingTip = {
  x: number;
  y: number;
  slope: number;
  mass: number;
  fade: number;
  sigma: number;
};

/** Fit the native pencil centre and its declining optical density separately.
 * A dark point gets more say in its position, but every observed scanline
 * contributes equally when extrapolating how quickly the pencil fades. */
function endTrend(points: Sample[], origin: number, position: boolean) {
  let sum = 0,
    x = 0,
    y = 0,
    xx = 0,
    xy = 0;
  for (const p of points) {
    const weight = position ? p.mass : 1;
    const offset = p.x - origin,
      value = position ? p.y : p.mass;
    sum += weight;
    x += weight * offset;
    y += weight * value;
    xx += weight * offset * offset;
    xy += weight * offset * value;
  }
  const slope = (xy - (x * y) / sum) / (xx - (x * x) / sum);
  return { level: (y - slope * x) / sum, slope };
}

function fadingTip(
  scan: Scan,
  index: Index,
  run: Sample[],
  start: boolean,
): FadingTip | undefined {
  const points = start ? run.slice(0, 13) : run.slice(-13);
  const x = points[start ? 0 : points.length - 1].x;
  const line = endTrend(points, x, true);
  const error = points
    .map((p) => Math.abs(p.y - line.level - (p.x - x) * line.slope))
    .sort((a, b) => a - b);
  if (
    Math.abs(line.slope) < 0.13 ||
    Math.abs(line.slope) > 0.85 ||
    error[Math.ceil(0.88 * (points.length - 1))] > 0.28 ||
    scan.distance[index(x, Math.round(line.level))] > 8
  )
    return;
  const tone = endTrend(points, x, false);
  return {
    x,
    y: line.level,
    slope: line.slope,
    mass: Math.max(7, tone.level),
    fade: tone.slope,
    sigma: median(points.map((p) => p.sigma)),
  };
}

function matchesTaper(start: FadingTip, end: FadingTip) {
  const gap = end.x - start.x;
  if (gap < 5 || gap > 40) return false;
  const slope = (end.y - start.y) / gap;
  if (
    Math.max(Math.abs(start.slope - slope), Math.abs(end.slope - slope)) >
      0.085 ||
    Math.abs(start.slope - end.slope) > 0.115
  )
    return false;
  const low = Math.min(start.mass, end.mass),
    high = Math.max(start.mass, end.mass);
  const sign = Math.sign(end.mass - start.mass);
  return (
    low <= 78 &&
    high >= 60 &&
    low <= 0.68 * high &&
    high <= 10 * low &&
    Math.min(sign * start.fade, sign * end.fade) >= -0.4 &&
    Math.max(sign * start.fade, sign * end.fade) >= 0.9
  );
}

function drawFadingGap(
  scan: Scan,
  index: Index,
  left: FadingTip,
  right: FadingTip,
) {
  const span = right.x - left.x;
  const path = Array.from({ length: span - 1 }, (_, n) => {
    const t = (n + 1) / span,
      y = left.y + t * (right.y - left.y);
    return {
      x: left.x + n + 1,
      y,
      t,
      d: scan.distance[index(left.x + n + 1, Math.round(y))],
    };
  });
  if (
    path.filter((p) => p.d === 0).length < 0.33 * path.length ||
    path.filter((p) => p.d < 4).length < 0.72 * path.length
  )
    return;
  for (const { x, y, t } of path) {
    const mass = (1 - t) * left.mass + t * right.mass,
      sigma = (1 - t) * left.sigma + t * right.sigma;
    const from = Math.round(y) - 2;
    const kernel = Array.from({ length: 5 }, (_, i) =>
      Math.exp(-0.5 * ((from + i - y) / sigma) ** 2),
    );
    const weight = kernel.reduce((a, b) => a + b, 0);
    kernel.forEach((w, i) => {
      const p = scan.offset(index(x, from + i));
      const level = Math.max(0, Math.round(255 - (mass * w) / weight));
      for (let c = 0; c < 3; c++)
        scan.out[p + c] = Math.min(level, scan.out[p + c]);
    });
  }
}

function continueFadingAlong(
  scan: Scan,
  rows: number,
  cols: number,
  index: Index,
) {
  const runs = scanRuns(scan, cols, rows, index, fadingPen);
  const tips = (start: boolean) =>
    runs.flatMap((run) => fadingTip(scan, index, run, start) ?? []);
  const right = tips(true);
  for (const left of tips(false)) {
    const matches = right.filter((end) => matchesTaper(left, end));
    // An ambiguous parallel screen or a branch doesn't identify the hidden pen.
    if (matches.length === 1) drawFadingGap(scan, index, left, matches[0]);
  }
}
