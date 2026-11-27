import type { PixelRect } from "./maskGeometry";

type Raster = { bitmap: Buffer; width: number; height: number };

/** A row of miniature book jackets shares two physical baselines. Require
 * sustained colour edges on all four sides of each jacket, a visible gutter
 * and a selected title inside each frame before isolating its reference. */
export function measuredJacketRow(source: Raster, selections: PixelRect[]) {
  const short = Math.min(source.width, source.height);
  const tall = selections.filter(
    (b) =>
      b.h > 0.075 * short &&
      b.h < 0.26 * short &&
      b.w < 0.1 * short &&
      b.h > 1.6 * b.w,
  );
  for (const first of tall) {
    const row = tall.filter(
      (b) =>
        Math.abs(b.y - first.y) < 0.52 * Math.max(b.h, first.h) &&
        Math.min(b.y + b.h, first.y + first.h) - Math.max(b.y, first.y) >
          0.43 * Math.min(b.h, first.h),
    );
    if (row.length < 2) continue;
    const frames = framesOnBaselines(source, row, short);
    const best = strongestAdjacentChain(frames);
    if (best && best.rects.length >= 2) return best.rects;
  }
  return [];
}

type Frame = { rect: PixelRect; score: number };

function framesOnBaselines(
  source: Raster,
  row: PixelRect[],
  short: number,
): Frame[] {
  const left = Math.min(...row.map((b) => b.x)),
    right = Math.max(...row.map((b) => b.x + b.w));
  if (right - left < 0.18 * short) return [];
  const upper = Math.min(...row.map((b) => b.y)),
    lower = Math.max(...row.map((b) => b.y + b.h));
  const top = edges(
    source,
    false,
    left,
    right,
    upper - 0.065 * short,
    upper + 0.015 * short,
  )[0];
  const base = edges(
    source,
    false,
    left,
    right,
    lower - 0.013 * short,
    lower + 0.1 * short,
  )[0];
  if (!top || !base || Math.min(top.score, base.score) < 50) return [];
  const height = base.at - top.at;
  if (height < 0.11 * short || height > 0.32 * short) return [];
  const sides = edges(
    source,
    true,
    top.at + 7,
    base.at - 7,
    left - 0.85 * height,
    right + 0.85 * height,
  );
  return framesAcrossRow(sides, row, top.at, height);
}

function framesAcrossRow(
  sides: ReturnType<typeof edges>,
  row: PixelRect[],
  top: number,
  height: number,
) {
  const frames: Frame[] = [];
  for (const a of sides)
    for (const b of sides) {
      const width = b.at - a.at;
      if (
        width < 0.57 * height ||
        width > 0.82 * height ||
        Math.min(a.score, b.score) < 54
      )
        continue;
      if (
        !row.some(
          (r) => r.x + r.w * 0.15 >= a.at - 1 && r.x + r.w * 0.85 <= b.at + 1,
        )
      )
        continue;
      frames.push({
        rect: { x: a.at, y: top, w: width, h: height },
        score: Math.sqrt(a.score * b.score),
      });
    }
  return frames;
}

function strongestAdjacentChain(frames: Frame[]) {
  // Dynamic programming favours more independently supported frames, then
  // stronger observed edges. The gap must be narrower than a title stroke.
  frames.sort((a, b) => a.rect.x - b.rect.x);
  const chains: Array<{ rects: PixelRect[]; score: number }> = [];
  for (const [i, frame] of frames.entries()) {
    const current = frame.rect;
    let best = { rects: [current], score: frame.score };
    for (let j = 0; j < i; j++) {
      const prior = frames[j].rect,
        gap = current.x - prior.x - prior.w;
      if (
        gap < 2 ||
        gap > 0.12 * current.w ||
        Math.abs(prior.w - current.w) > 0.08 * current.w
      )
        continue;
      const chain = chains[j],
        score = chain.score + frame.score;
      if (
        chain.rects.length + 1 > best.rects.length ||
        (chain.rects.length + 1 === best.rects.length && score > best.score)
      )
        best = { rects: [...chain.rects, current], score };
    }
    chains.push(best);
  }
  return chains.sort(
    (a, b) => b.rects.length - a.rects.length || b.score - a.score,
  )[0];
}

function edges(
  source: Raster,
  vertical: boolean,
  start: number,
  end: number,
  lo: number,
  hi: number,
) {
  const across = vertical ? source.width : source.height,
    along = vertical ? source.height : source.width;
  const first = Math.max(0, Math.ceil(start)),
    last = Math.min(along, Math.floor(end));
  const stride = vertical ? 4 : 4 * source.width;
  const candidates: Array<{ at: number; score: number }> = [];
  for (
    let at = Math.max(1, Math.floor(lo));
    at < Math.min(across - 1, Math.ceil(hi));
    at++
  ) {
    let count = 0,
      total = 0,
      strong = 0;
    for (let p = first; p < last; p += 2) {
      const i = 4 * (vertical ? p * source.width + at : at * source.width + p);
      let delta = 0;
      for (let c = 0; c < 3; c++)
        delta = Math.max(
          delta,
          Math.abs(
            source.bitmap[i + c - stride] - source.bitmap[i + c + stride],
          ),
        );
      total += Math.min(125, delta);
      strong += Number(delta > 32);
      count++;
    }
    const score = (total / count) * (0.25 + (0.75 * strong) / count);
    if (score > 38) candidates.push({ at, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const peaks: typeof candidates = [];
  for (const p of candidates) {
    if (peaks.every((other) => Math.abs(other.at - p.at) >= 5)) peaks.push(p);
    // Only the strongest independent printed edges can form jacket frames.
    if (peaks.length === 32) break;
  }
  return peaks;
}
