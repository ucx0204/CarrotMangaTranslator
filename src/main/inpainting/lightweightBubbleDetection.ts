import { clamp } from "../../shared/geometry";
import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import {
  bboxToPixelRect,
  expandRect,
  hasUsableBbox,
  resolvePatternBlockMarginPx,
  resolvePatternDilationRadius,
  type PixelRect,
} from "./maskGeometry";
import { resolveFlatBubbleFill } from "./hybridBubbleCleaning";
import { buildPatternTextMask } from "./patternTextMask";
import { readRgb } from "./rasterMasks";

type BubbleCandidate = {
  mask: Uint8Array;
  rect: PixelRect;
  sourceRect: PixelRect;
};

export type LightweightBubbleMaskResult = {
  mask: Uint8Array;
  matchedBlocks: number;
  regions: number;
  splitRegions: number;
};

export function buildLightweightBubbleMask(
  bitmap: Buffer,
  page: MangaPage,
): LightweightBubbleMaskResult {
  const candidates = page.blocks
    .filter((block) => hasUsableBbox(block.bbox) && !block.inpaintExcluded)
    .map((block) => detectFlatBubbleCandidate(bitmap, page, block))
    .filter((candidate): candidate is BubbleCandidate => Boolean(candidate));
  return composeCandidates(candidates, page.width, page.height);
}

function detectFlatBubbleCandidate(
  bitmap: Buffer,
  page: MangaPage,
  block: TranslationBlock,
): BubbleCandidate | null {
  const sourceRect = bboxToPixelRect(block.bbox, page);
  const detectRect = expandRect(
    sourceRect,
    page.width,
    page.height,
    resolvePatternBlockMarginPx(block, page),
  );
  const textMask = buildPatternTextMask(
    bitmap,
    page.width,
    page.height,
    detectRect,
    resolvePatternDilationRadius(block),
    { focusRect: sourceRect },
  );
  if (textMask.count === 0) {
    return null;
  }
  const fill = resolveFlatBubbleFill(
    bitmap,
    page.width,
    detectRect,
    textMask.mask,
  );
  if (!fill) {
    return null;
  }
  const margin = clamp(
    Math.round(Math.max(sourceRect.w, sourceRect.h) * 0.9),
    24,
    180,
  );
  const searchRect = expandRect(sourceRect, page.width, page.height, margin);
  const component = findBestFlatComponent(
    bitmap,
    page.width,
    searchRect,
    sourceRect,
    fill.color,
    fill.kind,
  );
  if (!component) {
    return null;
  }
  return {
    mask: erodeMask(component, searchRect.w, searchRect.h, 2),
    rect: searchRect,
    sourceRect,
  };
}

function findBestFlatComponent(
  bitmap: Buffer,
  pageWidth: number,
  rect: PixelRect,
  sourceRect: PixelRect,
  color: { r: number; g: number; b: number },
  kind: "black" | "white",
): Uint8Array | null {
  const candidates = buildFlatCandidateMask(
    bitmap,
    pageWidth,
    rect,
    color,
    kind,
  );
  const visited = new Uint8Array(candidates.length);
  let best: number[] = [];
  let bestScore = 0;
  for (let start = 0; start < candidates.length; start += 1) {
    if (!candidates[start] || visited[start]) {
      continue;
    }
    const component = collectComponent(
      candidates,
      visited,
      rect.w,
      rect.h,
      start,
    );
    const score = componentOverlapScore(component, rect, sourceRect);
    if (
      score > bestScore &&
      !isLikelyPageBackground(component, rect.w, rect.h)
    ) {
      best = component;
      bestScore = score;
    }
  }
  if (bestScore < Math.max(4, sourceRect.w * sourceRect.h * 0.015)) {
    return null;
  }
  const output = new Uint8Array(candidates.length);
  for (const index of best) {
    output[index] = 1;
  }
  return output;
}

function buildFlatCandidateMask(
  bitmap: Buffer,
  pageWidth: number,
  rect: PixelRect,
  background: { r: number; g: number; b: number },
  kind: "black" | "white",
): Uint8Array {
  const mask = new Uint8Array(rect.w * rect.h);
  for (let y = 0; y < rect.h; y += 1) {
    for (let x = 0; x < rect.w; x += 1) {
      const color = readRgb(bitmap, pageWidth, rect.x + x, rect.y + y);
      const luminance = color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
      const polarityMatches =
        kind === "white" ? luminance >= 190 : luminance <= 65;
      if (polarityMatches && colorDistance(color, background) <= 48) {
        mask[y * rect.w + x] = 1;
      }
    }
  }
  return mask;
}

function collectComponent(
  mask: Uint8Array,
  visited: Uint8Array,
  width: number,
  height: number,
  start: number,
): number[] {
  const queue = [start];
  const component: number[] = [];
  visited[start] = 1;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor];
    component.push(index);
    enqueueNeighbors(mask, visited, queue, width, height, index);
  }
  return component;
}

function enqueueNeighbors(
  mask: Uint8Array,
  visited: Uint8Array,
  queue: number[],
  width: number,
  height: number,
  index: number,
): void {
  const x = index % width;
  const y = Math.floor(index / width);
  for (const [dx, dy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]) {
    const nx = x + dx;
    const ny = y + dy;
    const next = ny * width + nx;
    if (
      nx >= 0 &&
      nx < width &&
      ny >= 0 &&
      ny < height &&
      mask[next] &&
      !visited[next]
    ) {
      visited[next] = 1;
      queue.push(next);
    }
  }
}

function componentOverlapScore(
  component: number[],
  rect: PixelRect,
  sourceRect: PixelRect,
): number {
  let score = 0;
  for (const index of component) {
    const x = rect.x + (index % rect.w);
    const y = rect.y + Math.floor(index / rect.w);
    if (
      x >= sourceRect.x &&
      x < sourceRect.x + sourceRect.w &&
      y >= sourceRect.y &&
      y < sourceRect.y + sourceRect.h
    ) {
      score += 1;
    }
  }
  return score;
}

function isLikelyPageBackground(
  component: number[],
  width: number,
  height: number,
): boolean {
  if (component.length < width * height * 0.75) {
    return false;
  }
  let edgePixels = 0;
  for (const index of component) {
    const x = index % width;
    const y = Math.floor(index / width);
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
      edgePixels += 1;
    }
  }
  return edgePixels > (width + height) * 0.8;
}

function erodeMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const output = new Uint8Array(mask.length);
  for (let y = radius; y < height - radius; y += 1) {
    for (let x = radius; x < width - radius; x += 1) {
      output[y * width + x] = maskPixelHasInset(mask, width, x, y, radius)
        ? 1
        : 0;
    }
  }
  return output;
}

function maskPixelHasInset(
  mask: Uint8Array,
  width: number,
  x: number,
  y: number,
  radius: number,
): boolean {
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (!mask[(y + dy) * width + x + dx]) {
        return false;
      }
    }
  }
  return true;
}

function composeCandidates(
  candidates: BubbleCandidate[],
  width: number,
  height: number,
): LightweightBubbleMaskResult {
  const output = new Uint8Array(width * height);
  for (const [candidateIndex, candidate] of candidates.entries()) {
    paintCandidate(output, width, candidates, candidate, candidateIndex);
  }
  return {
    mask: output,
    matchedBlocks: candidates.length,
    regions: candidates.length,
    splitRegions: 0,
  };
}

function paintCandidate(
  output: Uint8Array,
  width: number,
  candidates: BubbleCandidate[],
  candidate: BubbleCandidate,
  candidateIndex: number,
): void {
  const candidateId = Math.min(255, candidateIndex + 1);
  for (let localY = 0; localY < candidate.rect.h; localY += 1) {
    for (let localX = 0; localX < candidate.rect.w; localX += 1) {
      paintCandidatePixel({
        candidate,
        candidateId,
        candidates,
        localX,
        localY,
        output,
        width,
      });
    }
  }
}

function paintCandidatePixel(options: {
  candidate: BubbleCandidate;
  candidateId: number;
  candidates: BubbleCandidate[];
  localX: number;
  localY: number;
  output: Uint8Array;
  width: number;
}): void {
  const localIndex = options.localY * options.candidate.rect.w + options.localX;
  if (!options.candidate.mask[localIndex]) {
    return;
  }
  const x = options.candidate.rect.x + options.localX;
  const y = options.candidate.rect.y + options.localY;
  const pageIndex = y * options.width + x;
  const currentId = options.output[pageIndex] ?? 0;
  const currentRect = options.candidates[currentId - 1]?.sourceRect;
  if (
    !currentRect ||
    normalizedCenterDistance(options.candidate.sourceRect, x, y) <
      normalizedCenterDistance(currentRect, x, y)
  ) {
    options.output[pageIndex] = options.candidateId;
  }
}

function normalizedCenterDistance(
  rect: PixelRect,
  x: number,
  y: number,
): number {
  const dx = (x - (rect.x + rect.w / 2)) / Math.max(1, rect.w);
  const dy = (y - (rect.y + rect.h / 2)) / Math.max(1, rect.h);
  return dx * dx + dy * dy;
}

function colorDistance(
  left: { r: number; g: number; b: number },
  right: { r: number; g: number; b: number },
): number {
  return Math.hypot(left.r - right.r, left.g - right.g, left.b - right.b);
}
