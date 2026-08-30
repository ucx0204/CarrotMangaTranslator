import type { MangaPage } from "../../shared/libraryTypes";
import { stripRichTextMarkup } from "../../shared/richTextMarkup";
import { loadFontMatchingPageRaster } from "../fontMatchingPageImage";
import {
  estimateSourceFontFace,
  type SourceFontSizeEstimate,
} from "./sourceFontSizeGeometry";
import type { FontMatchingRasterPage } from "./fontMatchingPagePixelPreprocessing";
import { buildSourceFontCoreMask } from "./sourceFontSizeRaster";
import { logPipelineWarning } from "./pipelineLogger";
import type { OverlayItem } from "./types";

const EMPTY_ESTIMATES: readonly (SourceFontSizeEstimate | undefined)[] = [];
const MAX_LINE_FACE_DISPERSION = 0.35;
type SourceFontLine = NonNullable<
  OverlayItem["sourceFontLineGeometry"]
>["lines"][number];

export async function estimatePageSourceFontSizes({
  enabled,
  items,
  page,
  signal,
  loadRaster = loadFontMatchingPageRaster,
}: {
  enabled: boolean;
  items: readonly OverlayItem[];
  page: MangaPage;
  signal?: AbortSignal;
  loadRaster?: (
    page: MangaPage,
    signal?: AbortSignal,
  ) => Promise<FontMatchingRasterPage>;
}): Promise<readonly (SourceFontSizeEstimate | undefined)[]> {
  if (!enabled || items.length === 0) return EMPTY_ESTIMATES;
  try {
    throwIfAborted(signal);
    const raster = await loadRaster(page, signal);
    if (raster.width !== page.width || raster.height !== page.height) {
      throw new Error(
        "Source font-size raster dimensions do not match the page.",
      );
    }
    await yieldToEventLoop();
    const estimates: Array<SourceFontSizeEstimate | undefined> = [];
    for (const item of items) {
      throwIfAborted(signal);
      estimates.push(estimateSourceFontSizeForItem(raster, item, signal));
      await yieldToEventLoop();
    }
    return estimates;
  } catch (error) {
    if (signal?.aborted) throw error;
    logPipelineWarning("Source font-size matching failed closed for page", {
      error,
      pageId: page.id,
    });
    return EMPTY_ESTIMATES;
  }
}

export function estimateSourceFontSizeForItem(
  raster: FontMatchingRasterPage,
  item: OverlayItem,
  signal?: AbortSignal,
): SourceFontSizeEstimate | undefined {
  if (!isEligibleSourceSizeItem(item)) return undefined;
  const direction = item.direction;
  const sourceText = stripRichTextMarkup(item.sourceText ?? item.jp ?? "");
  const glyphCount = visibleGlyphCount(sourceText);
  if (glyphCount < 2 || glyphCount > 160) return undefined;
  const lineEstimate = estimateFromOcrLineGeometry(
    raster,
    item,
    direction,
    signal,
  );
  if (lineEstimate) return lineEstimate;
  const core = buildSourceFontCoreMask(raster, item.bbox, signal);
  return core
    ? (estimateSourceFontFace(core, direction, glyphCount) ?? undefined)
    : undefined;
}

function estimateFromOcrLineGeometry(
  raster: FontMatchingRasterPage,
  item: OverlayItem,
  direction: "horizontal" | "vertical",
  signal?: AbortSignal,
): SourceFontSizeEstimate | undefined {
  const geometry = item.sourceFontLineGeometry;
  if (
    geometry?.contractVersion !== "source-font-line-geometry-v1" ||
    geometry.source !== "ocr-geometry-lock" ||
    geometry.lines.length < 1
  ) {
    return undefined;
  }
  const voterIds = item.sourceCandidateMembership?.voterCandidateIds;
  const voterSet = voterIds ? new Set(voterIds) : null;
  const lineEstimates = collectOcrLineEstimates(
    raster,
    geometry.lines,
    direction,
    voterSet,
    signal,
  );
  return combineOcrLineEstimates(lineEstimates);
}

function collectOcrLineEstimates(
  raster: FontMatchingRasterPage,
  lines: readonly SourceFontLine[],
  direction: "horizontal" | "vertical",
  voterSet: ReadonlySet<number> | null,
  signal?: AbortSignal,
): SourceFontSizeEstimate[] {
  const seenCandidateIds = new Set<number>();
  const estimates: SourceFontSizeEstimate[] = [];
  for (const line of lines) {
    if (!claimSourceFontLine(line, voterSet, seenCandidateIds)) continue;
    const estimate = measureSourceFontLine(raster, line, direction, signal);
    if (estimate) estimates.push(estimate);
  }
  return estimates;
}

function claimSourceFontLine(
  line: SourceFontLine,
  voterSet: ReadonlySet<number> | null,
  seenCandidateIds: Set<number>,
): boolean {
  if (
    !Number.isInteger(line.candidateId) ||
    line.candidateId <= 0 ||
    seenCandidateIds.has(line.candidateId) ||
    (voterSet !== null && !voterSet.has(line.candidateId)) ||
    !isFiniteBbox(line.bbox)
  ) {
    return false;
  }
  seenCandidateIds.add(line.candidateId);
  return true;
}

function measureSourceFontLine(
  raster: FontMatchingRasterPage,
  line: SourceFontLine,
  direction: "horizontal" | "vertical",
  signal?: AbortSignal,
): SourceFontSizeEstimate | undefined {
  const glyphCount = visibleGlyphCount(stripRichTextMarkup(line.sourceText));
  if (glyphCount < 2 || glyphCount > 160) return undefined;
  const core = buildSourceFontCoreMask(raster, line.bbox, signal);
  return core
    ? (estimateSourceFontFace(core, direction, glyphCount) ?? undefined)
    : undefined;
}

function combineOcrLineEstimates(
  lineEstimates: readonly SourceFontSizeEstimate[],
): SourceFontSizeEstimate | undefined {
  if (lineEstimates.length === 0) return undefined;
  if (lineEstimates.length === 1) return lineEstimates[0];
  const faces = lineEstimates.map((estimate) => estimate.facePx);
  const facePx = median(faces);
  const dispersion =
    median(faces.map((face) => Math.abs(face - facePx))) / Math.max(1, facePx);
  if (dispersion > MAX_LINE_FACE_DISPERSION) return undefined;
  const baseConfidence = median(
    lineEstimates.map((estimate) => estimate.confidence),
  );
  return {
    confidence: clamp(baseConfidence - dispersion * 0.3, 0.5, 0.94),
    facePx,
    method: "raster-core-v1",
  };
}

function visibleGlyphCount(value: string): number {
  return Array.from(value).filter((grapheme) => !/^\s$/u.test(grapheme)).length;
}

function isFiniteBbox(value: {
  x: number;
  y: number;
  w: number;
  h: number;
}): boolean {
  return (
    [value.x, value.y, value.w, value.h].every(Number.isFinite) &&
    value.w > 0 &&
    value.h > 0
  );
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isEligibleSourceSizeItem(
  item: OverlayItem,
): item is OverlayItem & { direction: "horizontal" | "vertical" } {
  const role = item.textRole || "ordinary";
  const direction = item.direction;
  return (
    role === "ordinary" &&
    (direction === "horizontal" || direction === "vertical") &&
    Math.abs(Number(item.angle ?? 0)) <= 3
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
