import type { MangaPage } from "../../shared/libraryTypes";
import { stripRichTextMarkup } from "../../shared/richTextMarkup";
import { loadFontMatchingPageRaster } from "../fontMatchingPageImage";
import { measureSourceFontFaceForText } from "./sourceFontSizeTextEvidence";
import type { SourceFontSizeEstimate } from "./sourceFontSizeGeometryTypes";
import { buildCrossProfile, clamp, median } from "./sourceFontSizeMath";
import type { FontMatchingRasterPage } from "./fontMatchingPagePixelPreprocessing";
import {
  buildSourceFontCoreMask,
  type SourceFontCoreMask,
} from "./sourceFontSizeRaster";
import {
  createSourceFontSizeHypothesisCandidate,
  refinePageSourceFontSizeHypotheses,
} from "./sourceFontSizePeerGatedLattice";
import type { SourceFontSizeHypothesisCandidate } from "./sourceFontSizePeerGatedTypes";
import { logPipelineWarning } from "./pipelineLogger";
import type { OverlayItem } from "./types";

const EMPTY_ESTIMATES: readonly (SourceFontSizeEstimate | undefined)[] = [];
const MAX_LINE_FACE_DISPERSION = 0.35;
type SourceFontLine = NonNullable<
  OverlayItem["sourceFontLineGeometry"]
>["lines"][number];
type SourceFontSizeItemMeasurement = Readonly<{
  estimate?: SourceFontSizeEstimate;
  hypothesis?: SourceFontSizeHypothesisCandidate;
}>;

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
    const measurements: SourceFontSizeItemMeasurement[] = [];
    for (const item of items) {
      throwIfAborted(signal);
      measurements.push(measureSourceFontSizeItem(raster, item, signal));
      await yieldToEventLoop();
    }
    return refinePageMeasurements(measurements);
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
  return measureSourceFontSizeItem(raster, item, signal).estimate;
}

function measureSourceFontSizeItem(
  raster: FontMatchingRasterPage,
  item: OverlayItem,
  signal?: AbortSignal,
): SourceFontSizeItemMeasurement {
  if (!isEligibleSourceSizeItem(item)) return {};
  const direction = item.direction;
  const sourceText = stripRichTextMarkup(item.sourceText ?? item.jp ?? "");
  const glyphCount = visibleGlyphCount(sourceText);
  if (glyphCount < 1 || glyphCount > 160) return {};
  if (glyphCount === 1) {
    if (
      !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}!?！？]$/u.test(
        sourceText.trim(),
      )
    )
      return {};
    const core = buildSourceFontCoreMask(raster, item.bbox, signal);
    return {
      estimate: core ? measureSingleSourceGlyph(core, direction) : undefined,
    };
  }
  const lineMeasurement = measureFromOcrLineGeometry(
    raster,
    item,
    direction,
    signal,
  );
  if (lineMeasurement) return lineMeasurement;
  const core = buildSourceFontCoreMask(raster, item.bbox, signal);
  if (!core) return {};
  const measured = measureSourceFontFaceForText(
    core,
    direction,
    sourceText,
    true,
  );
  const { estimate } = measured;
  return estimate
    ? {
        estimate,
        hypothesis: createSourceFontSizeHypothesisCandidate({
          baseline: estimate,
          core,
          direction,
          glyphCount: measured.glyphCount,
        }),
      }
    : {};
}

function measureFromOcrLineGeometry(
  raster: FontMatchingRasterPage,
  item: OverlayItem,
  direction: "horizontal" | "vertical",
  signal?: AbortSignal,
): SourceFontSizeItemMeasurement | undefined {
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
  const lineMeasurements = collectOcrLineMeasurements(
    raster,
    geometry.lines,
    direction,
    voterSet,
    signal,
  );
  if (lineMeasurements.length === 1) return lineMeasurements[0];
  const estimate = combineOcrLineEstimates(
    lineMeasurements.flatMap((measurement) =>
      measurement.estimate ? [measurement.estimate] : [],
    ),
  );
  return estimate ? { estimate } : undefined;
}

function collectOcrLineMeasurements(
  raster: FontMatchingRasterPage,
  lines: readonly SourceFontLine[],
  direction: "horizontal" | "vertical",
  voterSet: ReadonlySet<number> | null,
  signal?: AbortSignal,
): SourceFontSizeItemMeasurement[] {
  const seenLineKeys = new Set<string>();
  const measurements: SourceFontSizeItemMeasurement[] = [];
  for (const line of lines) {
    if (!claimSourceFontLine(line, voterSet, seenLineKeys)) continue;
    const measurement = measureSourceFontLine(raster, line, direction, signal);
    if (measurement) measurements.push(measurement);
  }
  return measurements;
}

function claimSourceFontLine(
  line: SourceFontLine,
  voterSet: ReadonlySet<number> | null,
  seenLineKeys: Set<string>,
): boolean {
  const lineKey = `${line.candidateId}:${line.bbox.x}:${line.bbox.y}:${line.bbox.w}:${line.bbox.h}`;
  if (
    !Number.isInteger(line.candidateId) ||
    line.candidateId <= 0 ||
    seenLineKeys.has(lineKey) ||
    (voterSet !== null && !voterSet.has(line.candidateId)) ||
    !isFiniteBbox(line.bbox)
  ) {
    return false;
  }
  seenLineKeys.add(lineKey);
  return true;
}

function measureSourceFontLine(
  raster: FontMatchingRasterPage,
  line: SourceFontLine,
  direction: "horizontal" | "vertical",
  signal?: AbortSignal,
): SourceFontSizeItemMeasurement | undefined {
  const glyphCount = visibleGlyphCount(stripRichTextMarkup(line.sourceText));
  if (glyphCount < 2 || glyphCount > 160) return undefined;
  const core = buildSourceFontCoreMask(raster, line.bbox, signal);
  if (!core) return undefined;
  const measured = measureSourceFontFaceForText(
    core,
    direction,
    stripRichTextMarkup(line.sourceText),
    false,
  );
  const { estimate } = measured;
  return estimate
    ? {
        estimate,
        hypothesis: createSourceFontSizeHypothesisCandidate({
          baseline: estimate,
          core,
          direction,
          glyphCount: measured.glyphCount,
        }),
      }
    : undefined;
}

function refinePageMeasurements(
  measurements: readonly SourceFontSizeItemMeasurement[],
): readonly (SourceFontSizeEstimate | undefined)[] {
  const candidateSlots = measurements.flatMap((measurement, index) =>
    measurement.hypothesis
      ? [{ hypothesis: measurement.hypothesis, index }]
      : [],
  );
  const refined = refinePageSourceFontSizeHypotheses(
    candidateSlots.map((slot) => slot.hypothesis),
  );
  const refinedByIndex = new Map(
    candidateSlots.map((slot, index) => [slot.index, refined[index]]),
  );
  return measurements.map(
    (measurement, index) => refinedByIndex.get(index) ?? measurement.estimate,
  );
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
  // Used only for eligibility. Occupancy alternatives need raster agreement.
  return Array.from(value.replace(/\.{3}/gu, "…")).filter(
    (grapheme) => !/^\s$/u.test(grapheme),
  ).length;
}

function measureSingleSourceGlyph(
  core: SourceFontCoreMask,
  direction: "horizontal" | "vertical",
): SourceFontSizeEstimate | undefined {
  if (
    core.componentCount > 12 ||
    core.foregroundRatio < 0.015 ||
    core.foregroundRatio > 0.47
  )
    return undefined;
  const profile = buildCrossProfile(core, direction);
  const mass = profile.reduce((sum, value) => sum + value, 0);
  let cumulative = 0;
  let first = -1;
  let last = -1;
  for (const [index, value] of profile.entries()) {
    cumulative += value;
    if (first < 0 && cumulative >= mass * 0.02) first = index;
    if (cumulative <= mass * 0.98 || last < 0) last = index;
  }
  const facePx = last - first + 1;
  return facePx >= 6
    ? { facePx, confidence: 0.65, method: "raster-core-v1" }
    : undefined;
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
