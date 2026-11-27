import { distanceToMask } from "./pageMaskComposite";
import type { PixelRect } from "./maskGeometry";

type Page = { source: Buffer; width: number; height: number };
type Window = Page & {
  crop: PixelRect;
  selected: Uint8Array;
  generated: Buffer;
};
type Witness = Window & { distance: Float32Array };
type Corner = { x: number; y: number; side: number; down: number };
type Rail = { at: number; count: number };
type Point = { u: number; v: number; level: number; weight: number };
type Match = { x: number; dy: number; score: number };

function tone(page: Page, x: number, y: number) {
  return page.source[4 * (y * page.width + x) + 1];
}

function smooth(page: Page, x: number, y: number) {
  return (
    (4 * tone(page, x, y) +
      tone(page, x + 1, y) +
      tone(page, x - 1, y) +
      tone(page, x, y + 1) +
      tone(page, x, y - 1)) /
    8
  );
}

function clearance(view: Witness, x: number, y: number) {
  const b = view.crop;
  if (x < b.x || y < b.y || x >= b.x + b.w || y >= b.y + b.h) return Infinity;
  return view.distance[(y - b.y) * b.w + x - b.x];
}

function clipped(view: Page, x: number, y: number, pad: number) {
  return x < pad || y < pad || x >= view.width - pad || y >= view.height - pad;
}

function selectPeaks(rails: Rail[], limit: number) {
  const peaks: Rail[] = [];
  for (const rail of rails.sort((a, b) => b.count - a.count)) {
    if (peaks.every((p) => Math.abs(p.at - rail.at) > 4)) peaks.push(rail);
    if (peaks.length === limit) break;
  }
  return peaks;
}

function isFramePen(
  view: Witness,
  x: number,
  y: number,
  dx: number,
  dy: number,
) {
  const inner =
    (tone(view, x - 4 * dx, y - 4 * dy) + tone(view, x - 7 * dx, y - 7 * dy)) /
    2;
  const outer =
    (tone(view, x + 4 * dx, y + 4 * dy) + tone(view, x + 7 * dx, y + 7 * dy)) /
    2;
  const pen = tone(view, x, y);
  return (
    inner > 64 &&
    inner < 213 &&
    outer > inner + 24 &&
    outer > 166 &&
    pen < inner - 20 &&
    pen < outer - 36
  );
}

/** A thin native pen with shaded frame material inside and lighter wall outside. */
function rails(
  view: Witness,
  across: [number, number],
  along: [number, number],
  sign: number,
  horizontal: boolean,
  minimum: number,
  limit: number,
) {
  const candidates: Rail[] = [];
  const dx = horizontal ? 0 : sign,
    dy = horizontal ? sign : 0;
  const maxAcross = horizontal ? view.height : view.width;
  const maxAlong = horizontal ? view.width : view.height;
  for (
    let pos = Math.max(9, across[0]);
    pos <= Math.min(maxAcross - 10, across[1]);
    pos++
  ) {
    let count = 0;
    for (
      let t = Math.max(2, along[0]);
      t <= Math.min(maxAlong - 3, along[1]);
      t += 2
    ) {
      const x = horizontal ? t : pos,
        y = horizontal ? pos : t;
      if (clearance(view, x, y) < 3) continue;
      if (isFramePen(view, x, y, dx, dy)) count++;
    }
    if (count >= minimum) candidates.push({ at: pos, count });
  }
  return selectPeaks(candidates, limit);
}

function sorted(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

function measuredPoint(
  view: Witness,
  c: Corner,
  u: number,
  v: number,
): Point | undefined {
  if (v >= 21 && (u < -10 || u > 9)) return;
  const x = c.x + c.side * u,
    y = c.y + c.down * v;
  if (clipped(view, x, y, 3) || clearance(view, x, y) < 3.5) return;
  const grad =
    Math.hypot(
      smooth(view, x + 1, y) - smooth(view, x - 1, y),
      smooth(view, x, y + 1) - smooth(view, x, y - 1),
    ) / 2;
  if (grad >= 8)
    return { u, v, level: smooth(view, x, y), weight: Math.min(2, grad / 22) };
}

function nativePoints(view: Witness, c: Corner) {
  const points: Point[] = [];
  for (let v = -4; v < 96; v += 2)
    for (let u = -45; u <= 15; u += 2) {
      const point = measuredPoint(view, c, u, v);
      if (point) points.push(point);
    }
  const witnesses = [
    points.filter((p) => p.v < 6 && p.u < -18),
    points.filter((p) => p.v >= 2 && p.v < 21 && p.u > -36 && p.u < 0),
    points.filter((p) => p.v >= 21 && Math.abs(p.u) < 10),
  ];
  return points.length >= 36 && witnesses.every((group) => group.length >= 4)
    ? points
    : [];
}

function matchError(
  view: Witness,
  c: Corner,
  pts: Point[],
  x: number,
  dy: number,
) {
  const sum = [0, 0],
    mass = [0, 0];
  for (const p of pts) {
    const tx = x - c.side * p.u,
      ty = c.y + dy + c.down * p.v;
    if (clipped(view, tx, ty, 2) || clearance(view, tx, ty) < 3) continue;
    const group = Number(p.v >= 18);
    sum[group] +=
      Math.min(70, Math.abs(p.level - smooth(view, tx, ty))) * p.weight;
    mass[group] += p.weight;
  }
  const errors = sum.map((err, i) => err / Math.max(0.01, mass[i]));
  return Math.min(...mass) > 14 && Math.max(...errors) < 38
    ? errors[0] + errors[1]
    : Infinity;
}

function registeredPost(view: Witness, c: Corner, pts: Point[], at: number) {
  let best: Match = { x: at, dy: 0, score: Infinity };
  for (let x = at - 2; x <= at + 2; x++)
    for (let dy = -4; dy <= 4; dy++) {
      const score = matchError(view, c, pts, x, dy);
      if (score < best.score) best = { x, dy, score };
    }
  return best;
}

function opposite(view: Witness, c: Corner) {
  const pts = nativePoints(view, c);
  if (!pts.length) return;
  const estimates = rails(
    view,
    sorted(c.x - 100 * c.side, c.x - 1300 * c.side),
    sorted(c.y + 36 * c.down, c.y + 150 * c.down),
    -c.side,
    false,
    15,
    12,
  );
  const matches: Match[] = [];
  for (const { at } of estimates) {
    const best = registeredPost(view, c, pts, at);
    if (Number.isFinite(best.score)) matches.push(best);
  }
  matches.sort((a, b) => a.score - b.score);
  if (
    !matches.length ||
    matches[0].score > 56 ||
    (matches[1] && matches[1].score < matches[0].score + 4)
  )
    return;
  return matches[0];
}

function exteriorError(view: Witness, c: Corner, ref: Match, step: number) {
  let cost = 0,
    n = 0,
    shadow = 0;
  for (let v = 54; v <= 149; v += 3)
    for (let u = 3; u < 26; u++) {
      const x = c.x + c.side * u,
        y = c.y + c.down * v,
        tx = ref.x - c.side * (u + step),
        ty = y + ref.dy;
      if (
        clipped(view, x, y, 2) ||
        clipped(view, tx, ty, 2) ||
        clearance(view, x, y) < 5
      )
        continue;
      const native = smooth(view, x, y),
        peer = smooth(view, tx, ty);
      if (native < 178 || peer < 167) continue;
      cost += Math.min(34, Math.abs(native - peer));
      if (native < 235 && peer < 235) shadow++;
      n++;
    }
  return n >= 65 && shadow >= 14 ? cost / n + 0.12 * Math.abs(step) : Infinity;
}
function wallOffset(view: Witness, c: Corner, ref: Match) {
  const scores = [-3, -2, -1, 0, 1, 2, 3].map((step) => ({
    step,
    cost: exteriorError(view, c, ref, step),
  }));
  scores.sort((a, b) => a.cost - b.cost);
  if (scores[0].cost < 12) return scores[0].step;
}

function wallPixel(
  view: Witness,
  c: Corner,
  ref: Match,
  offset: number,
  u: number,
  v: number,
) {
  const x = c.x + c.side * u,
    y = c.y + c.down * v,
    tx = ref.x - c.side * (u + offset),
    ty = y + ref.dy;
  const clear = clearance(view, x, y);
  if (clear > 12 || clipped(view, x, y, 2) || clipped(view, tx, ty, 2)) return;
  const i = 4 * ((y - view.crop.y) * view.crop.w + x - view.crop.x),
    src = 4 * (y * view.width + x),
    peer = 4 * (ty * view.width + tx);
  if (
    view.source[src + 3] !== 255 ||
    view.source[peer + 3] !== 255 ||
    smooth(view, tx, ty) < 180
  )
    return;
  return { i, src, peer, clear, u, v };
}

function wallSamples(view: Witness, c: Corner, ref: Match, offset: number) {
  const samples: NonNullable<ReturnType<typeof wallPixel>>[] = [];
  let votes = 0,
    minU = Infinity,
    maxU = 0,
    minV = Infinity,
    maxV = 0;
  for (let v = 0; v < 151; v++)
    for (let u = 2; u <= 45; u++) {
      const pixel = wallPixel(view, c, ref, offset, u, v);
      if (!pixel) continue;
      const { i, src, peer, clear } = pixel;
      const a = view.source[src + 1],
        b = view.source[peer + 1],
        current = view.generated[i + 1];
      if (clear > 0 && a > 234 && b > 218 && current < Math.min(a, b) - 31) {
        votes++;
        minU = Math.min(minU, u);
        maxU = Math.max(maxU, u);
        minV = Math.min(minV, v);
        maxV = Math.max(maxV, v);
      }
      samples.push(pixel);
    }
  if (votes < 10 || maxU - minU < 6 || maxV - minV < 6) return [];
  return samples.filter(
    (p) =>
      p.u >= minU - 12 &&
      p.u <= maxU + 12 &&
      p.v >= minV - 12 &&
      p.v <= maxV + 12,
  );
}

function repair(view: Witness, c: Corner) {
  const ref = opposite(view, c);
  if (!ref) return false;
  const offset = wallOffset(view, c, ref);
  if (offset === undefined) return false;
  const pixels = wallSamples(view, c, ref, offset);
  for (const { i, src, peer, clear, u, v } of pixels) {
    const a = view.source[src + 1],
      b = view.source[peer + 1],
      current = view.generated[i + 1];
    const original =
      (clear > 2 && Math.abs(a - b) < 19) ||
      Math.abs(a - b) < 8 ||
      (a > 245 && b > 243) ||
      (clear > 0 && Math.abs(a - current) <= 2);
    const sample = original ? src : peer;
    const blend = Math.min(1, (46 - u) / 6, (151 - v) / 9);
    for (let ch = 0; ch < 3; ch++)
      view.generated[i + ch] = Math.round(
        view.generated[i + ch] * (1 - blend) + blend * view.source[sample + ch],
      );
  }
  return pixels.length > 0;
}

function selection(view: Window) {
  let left = view.crop.w,
    top = view.crop.h,
    right = -1,
    bottom = -1,
    count = 0,
    coloured = 0;
  view.selected.forEach((on, i) => {
    if (!on) return;
    const x = i % view.crop.w,
      y = Math.floor(i / view.crop.w);
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
    const j = 4 * ((view.crop.y + y) * view.width + view.crop.x + x);
    if (
      Math.max(view.source[j], view.source[j + 1], view.source[j + 2]) -
        Math.min(view.source[j], view.source[j + 1], view.source[j + 2]) >
      10
    )
      coloured++;
    count++;
  });
  if (
    count < 70 ||
    coloured > 0.025 * count ||
    Math.min(right - left, bottom - top) < 19 ||
    Math.max(right - left, bottom - top) > 307
  )
    return;
  return {
    x: view.crop.x + left,
    y: view.crop.y + top,
    w: right - left + 1,
    h: bottom - top + 1,
  };
}

/** Verify both unprinted corners of the same frame before replacing a decoder
 * stroke that crosses the original paper outside its upright. */
export function restoreMirroredFrameCorner(input: Window) {
  const bounds = selection(input);
  if (!bounds) return false;
  const view: Witness = {
    ...input,
    distance: distanceToMask(input.selected, input.crop.w, input.crop.h),
  };
  return [-1, 1].some((side) => repairSide(view, bounds, side));
}
function repairSide(view: Witness, bounds: PixelRect, side: number) {
  const posts = rails(
    view,
    [bounds.x - 40, bounds.x + bounds.w + 40],
    [bounds.y - 36, bounds.y + bounds.h + 62],
    side,
    false,
    17,
    3,
  );
  return posts.some(({ at: x }) =>
    [-1, 1].some((down) => {
      const edges = rails(
        view,
        [bounds.y - 52, bounds.y + bounds.h + 52],
        sorted(x - 117 * side, x - 17 * side),
        -down,
        true,
        21,
        4,
      );
      return edges.some(({ at: y }) => repair(view, { x, y, side, down }));
    }),
  );
}
