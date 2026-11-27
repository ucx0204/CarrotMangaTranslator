import { solveLinearSystem } from "../../shared/thinPlateSpline";
import type { ScreenScan } from "./qwenDotPrint";

type Point = { x: number; y: number };
type Bank = Point[];
type Edge = { line: (y: number) => number; above: Bank; below: Bank };
function bankTone(scan: ScreenScan, x: number, y: number) {
  let sum = 0,
    square = 0,
    known = 0;
  for (let row = y - 2; row <= y + 2; row++)
    for (let col = x - 5; col <= x + 5; col++) {
      const i = row * scan.width + col,
        v = scan.gray[i];
      sum += v;
      square += v * v;
      known += Number(scan.distance[i] > 4);
    }
  const mean = sum / 55;
  return {
    mean,
    noise: Math.sqrt(Math.max(0, square / 55 - mean * mean)),
    known: known / 55,
  };
}

function paperAtEdge(scan: ScreenScan, x: number, y: number) {
  const i = y * scan.width + x;
  if (scan.gray[i] >= 145 || scan.distance[i] <= 3) return false;
  const white = bankTone(scan, x - 9, y);
  if (white.mean <= 248 || white.known <= 0.89) return false;
  const screen = bankTone(scan, x + 9, y);
  return (
    screen.mean > 190 &&
    screen.mean < 246 &&
    screen.noise > 6 &&
    screen.noise < 33 &&
    screen.known > 0.89
  );
}

function rowCenters(scan: ScreenScan, y: number) {
  const result: Point[] = [];
  let x = 17;
  while (x < scan.width - 17) {
    if (!paperAtEdge(scan, x, y)) {
      x++;
      continue;
    }
    const begin = x++;
    while (x < scan.width - 17 && paperAtEdge(scan, x, y)) x++;
    if (x - begin > 5) continue;
    let mass = 0,
      center = 0;
    for (let j = begin - 1; j <= x; j++) {
      const ink = Math.max(0, 218 - scan.gray[y * scan.width + j]);
      mass += ink;
      center += ink * j;
    }
    result.push({ x: center / mass, y });
  }
  return result;
}

function nearestTrack(active: Bank[], used: Set<Bank>, point: Point) {
  let nearest: Bank | undefined;
  let best = Infinity;
  for (const track of active) {
    const last = track[track.length - 1];
    const delta = Math.abs(point.x - last.x);
    if (
      !used.has(track) &&
      delta < 1.3 * (point.y - last.y) + 0.8 &&
      delta < best
    ) {
      best = delta;
      nearest = track;
    }
  }
  return nearest;
}

function tracedBanks(scan: ScreenScan) {
  const tracks: Bank[] = [];
  let active: Bank[] = [];
  for (let y = 3; y < scan.height - 3; y++) {
    active = active.filter((track) => y - track[track.length - 1].y <= 3);
    const used = new Set<Bank>();
    for (const p of rowCenters(scan, y)) {
      let match = nearestTrack(active, used, p);
      if (!match) {
        match = [];
        tracks.push(match);
        active.push(match);
      }
      match.push(p);
      used.add(match);
    }
  }
  return tracks.filter(
    (t) => t.length >= 10 && t[t.length - 1].y - t[0].y >= 10,
  );
}

function quadratic(points: Bank, mid: number) {
  const gram = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
    rhs = [0, 0, 0];
  for (const p of points) {
    const d = (p.y - mid) / 32,
      terms = [1, d, d * d];
    for (let i = 0; i < 3; i++) {
      rhs[i] += terms[i] * p.x;
      for (let j = 0; j < 3; j++) gram[i][j] += terms[i] * terms[j];
    }
  }
  const [a, b, c] = solveLinearSystem(gram, rhs);
  return (y: number) => {
    const d = (y - mid) / 32;
    return a + d * (b + c * d);
  };
}

function fitScreenContour(points: Bank, mid: number) {
  const errors: number[] = [];
  const fits = [0, 1].map((phase) => {
    const held = (p: Point) => Math.floor(p.y / 4) % 3 === phase;
    const line = quadratic(
      points.filter((p) => !held(p)),
      mid,
    );
    for (const p of points.filter(held)) errors.push(Math.abs(line(p.y) - p.x));
    return line;
  });
  errors.sort((l, r) => l - r);
  if (errors[Math.floor(0.92 * (errors.length - 1))] > 0.75) return;
  const line = quadratic(points, mid);
  return { line, fits };
}

function crossesOriginalSelection(
  scan: ScreenScan,
  top: number,
  bottom: number,
  fits: Array<(y: number) => number>,
  line: (y: number) => number,
) {
  let selected = 0,
    close = 0;
  for (let y = top - 4; y <= bottom + 4; y++) {
    const x = Math.round(line(y));
    if (
      Math.abs(fits[0](y) - fits[1](y)) > 0.86 ||
      Math.abs(line(y + 1) - line(y)) > 0.95 ||
      x < 8 ||
      x >= scan.width - 9 ||
      y < 0 ||
      y >= scan.height
    )
      return;
    const i = y * scan.width + x;
    selected += Number(!!scan.mask[i]);
    close += Number(scan.distance[i] < 6);
  }
  return (
    selected >= 0.18 * (bottom - top + 9) && close >= 0.33 * (bottom - top + 9)
  );
}

function supportedCurve(scan: ScreenScan, above: Bank, below: Bank) {
  const a = above[above.length - 1],
    b = below[0],
    gap = b.y - a.y;
  if (gap < 9 || gap > 140 || Math.abs(a.x - b.x) > gap + 1) return;
  const points = [...above.slice(-46), ...below.slice(0, 46)],
    mid = (a.y + b.y) / 2;
  const measured = fitScreenContour(points, mid);
  if (!measured) return;
  const { line, fits } = measured;
  if (crossesOriginalSelection(scan, a.y, b.y, fits, line))
    return { above, below, line };
}

/** Two independent fits must place the covered outline within one native
 * pixel. Motion lines beside the lettering do not separate these two stocks. */
export function interruptedScreenCurve(scan: ScreenScan) {
  const tracks = tracedBanks(scan),
    fits: Edge[] = [];
  for (const above of tracks)
    for (const below of tracks) {
      const curve = supportedCurve(scan, above, below);
      if (curve) fits.push(curve);
    }
  if (fits.length === 1) return fits[0];
}
