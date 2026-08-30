import type { OverlayItem } from "./types";
import {
  bboxContainmentRatio,
  expandNormalizedBbox,
  isPlausibleMergedModelExtent,
} from "./overlayOcrGeometryMath";

type BBox = { x: number; y: number; w: number; h: number };
type PageSize = { width: number; height: number };

const MIN_SOURCE_LINE_CROSS_SHARE = 0.58;

export type OcrGeometryLockHint = {
  id: number;
  bbox: BBox;
  ocrText?: string;
  groupId?: string;
  containerType?: string;
};

export function stripSourceFontLineGeometry(item: OverlayItem): OverlayItem {
  const { sourceFontLineGeometry: _untrusted, ...clean } = item;
  return clean;
}

export function attachSourceFontLineGeometry(
  item: OverlayItem,
  hints: readonly OcrGeometryLockHint[],
): OverlayItem {
  const sourceHints = selectSourceFontLineHints(item, hints);
  if (sourceHints.length === 0) {
    return item;
  }
  return {
    ...item,
    sourceFontLineGeometry: {
      contractVersion: "source-font-line-geometry-v1",
      source: "ocr-geometry-lock",
      lines: sourceHints.map((hint) => ({
        candidateId: hint.id,
        bbox: hint.bbox,
        sourceText: String(hint.ocrText ?? ""),
      })),
    },
  };
}

/**
 * Legacy/direct model output identifies only a representative OCR id. The
 * model bbox can still be the authoritative envelope for several OCR lines,
 * including lines split across review groups or a detached leading glyph.
 * Recover only exact, unclaimed source fragments that live inside that
 * envelope, cover most of the model source text, and collectively make the
 * model extent plausible. Exact candidateIds remain authoritative upstream.
 */
export function resolveModelEnvelopeTextHints(
  item: OverlayItem,
  lockedHint: OcrGeometryLockHint,
  hintMap: ReadonlyMap<number, OcrGeometryLockHint>,
  claimedCandidateIds: ReadonlySet<number>,
  page: PageSize,
): OcrGeometryLockHint[] {
  const source = normalizeGlyphText(item.sourceText ?? item.jp);
  const lockedText = normalizeGlyphText(lockedHint.ocrText);
  if (!canSeedModelEnvelope(source, lockedText)) {
    return [lockedHint];
  }

  const covered = new Uint8Array(source.length);
  markBestDistinctSourceOccurrence(source, lockedText, covered);
  const selected = [lockedHint];
  for (const candidate of modelEnvelopeCandidates(
    item,
    lockedHint,
    hintMap,
    claimedCandidateIds,
    page,
  )) {
    const candidateText = normalizeGlyphText(candidate.ocrText);
    const minimumGain = Math.max(1, Math.ceil(candidateText.length * 0.8));
    const newlyCovered = markBestDistinctSourceOccurrence(
      source,
      candidateText,
      covered,
      minimumGain,
    );
    if (newlyCovered >= minimumGain) selected.push(candidate);
  }

  if (!hasReliableEnvelopeCoverage(source, covered, selected)) {
    return [lockedHint];
  }
  const hintUnion = unionBboxes(selected.map((candidate) => candidate.bbox));
  return isPlausibleMergedModelExtent(item.bbox, hintUnion)
    ? selected
    : [lockedHint];
}

export function sourceContainsHintText(
  item: OverlayItem,
  hint: OcrGeometryLockHint,
): boolean {
  const source = normalizeGlyphText(item.sourceText ?? item.jp);
  const candidate = normalizeGlyphText(hint.ocrText);
  return candidate.length > 0 && source.includes(candidate);
}

export function hintBelongsToModelEnvelope(
  item: OverlayItem,
  hint: OcrGeometryLockHint,
  page: PageSize,
): boolean {
  const fontSizePx =
    Number.isFinite(Number(item.fontSize)) && Number(item.fontSize) > 0
      ? Number(item.fontSize)
      : 12;
  const envelope = expandNormalizedBbox(
    item.bbox,
    ((fontSizePx * 0.5) / Math.max(1, page.width)) * 1000,
    ((fontSizePx * 0.5) / Math.max(1, page.height)) * 1000,
  );
  return bboxContainmentRatio(hint.bbox, envelope) >= 0.72;
}

function selectSourceFontLineHints(
  item: OverlayItem,
  hints: readonly OcrGeometryLockHint[],
): OcrGeometryLockHint[] {
  const source = normalizeGlyphText(item.sourceText ?? item.jp);
  if (source.length < 2) return [];
  const covered = new Uint8Array(source.length);
  const selected: OcrGeometryLockHint[] = [];
  const candidates = [...hints].sort(
    (left, right) =>
      normalizeGlyphText(right.ocrText).length -
        normalizeGlyphText(left.ocrText).length || left.id - right.id,
  );
  for (const candidate of candidates) {
    const candidateText = normalizeGlyphText(candidate.ocrText);
    if (!candidateText) continue;
    const minimumGain = Math.max(1, Math.ceil(candidateText.length * 0.8));
    const exactGain = markBestDistinctSourceOccurrence(
      source,
      candidateText,
      covered,
      minimumGain,
    );
    const gain = exactGain
      ? exactGain
      : markBestApproximateSourceOccurrence(
          source,
          candidateText,
          covered,
          minimumGain,
        );
    if (gain >= minimumGain) selected.push(candidate);
  }
  return excludeSmallCrossAxisAnnotations(item, selected);
}

function excludeSmallCrossAxisAnnotations(
  item: OverlayItem,
  selected: OcrGeometryLockHint[],
): OcrGeometryLockHint[] {
  if (selected.length < 2) return selected;
  const vertical = resolveItemDirection(item) === "vertical";
  const crossExtent = (hint: OcrGeometryLockHint) =>
    vertical ? hint.bbox.w : hint.bbox.h;
  const maximumCross = Math.max(...selected.map(crossExtent));
  return selected.filter(
    (hint) => crossExtent(hint) >= maximumCross * MIN_SOURCE_LINE_CROSS_SHARE,
  );
}

function canSeedModelEnvelope(source: string, lockedText: string): boolean {
  return (
    source.length >= 2 && lockedText.length > 0 && source.includes(lockedText)
  );
}

function modelEnvelopeCandidates(
  item: OverlayItem,
  lockedHint: OcrGeometryLockHint,
  hintMap: ReadonlyMap<number, OcrGeometryLockHint>,
  claimedCandidateIds: ReadonlySet<number>,
  page: PageSize,
): OcrGeometryLockHint[] {
  return [...hintMap.values()]
    .filter(
      (candidate) =>
        candidate.id !== lockedHint.id &&
        !claimedCandidateIds.has(candidate.id) &&
        sourceContainsHintText(item, candidate) &&
        hintBelongsToModelEnvelope(item, candidate, page),
    )
    .sort(
      (left, right) =>
        normalizeGlyphText(right.ocrText).length -
          normalizeGlyphText(left.ocrText).length || left.id - right.id,
    );
}

function hasReliableEnvelopeCoverage(
  source: string,
  covered: Uint8Array,
  selected: readonly OcrGeometryLockHint[],
): boolean {
  if (selected.length < 2) return false;
  const coverage =
    covered.reduce((total, value) => total + value, 0) / source.length;
  return coverage >= 0.72;
}

function markBestDistinctSourceOccurrence(
  source: string,
  candidate: string,
  covered: Uint8Array,
  minimumGain = 1,
): number {
  if (!candidate) return 0;
  let bestStart = -1;
  let bestGain = 0;
  let searchFrom = 0;
  while (searchFrom <= source.length - candidate.length) {
    const start = source.indexOf(candidate, searchFrom);
    if (start < 0) break;
    const gain = countUncovered(covered, start, candidate.length);
    if (gain > bestGain) {
      bestStart = start;
      bestGain = gain;
    }
    searchFrom = start + 1;
  }
  if (bestStart < 0 || bestGain < minimumGain) return 0;
  markCovered(covered, bestStart, candidate.length);
  return bestGain;
}

function markBestApproximateSourceOccurrence(
  source: string,
  candidate: string,
  covered: Uint8Array,
  minimumGain: number,
): number {
  if (candidate.length < 3 || candidate.length > source.length) return 0;
  const allowedMismatches = Math.min(
    3,
    Math.max(1, Math.floor(candidate.length * 0.2)),
  );
  let best: ApproximateOccurrence | null = null;
  for (let start = 0; start <= source.length - candidate.length; start += 1) {
    const occurrence = scoreApproximateOccurrence(
      source,
      candidate,
      covered,
      start,
    );
    if (
      isBetterApproximateOccurrence(
        occurrence,
        best,
        allowedMismatches,
        minimumGain,
      )
    ) {
      best = occurrence;
    }
  }
  if (!best) return 0;
  markCovered(covered, best.start, candidate.length);
  return best.gain;
}

type ApproximateOccurrence = {
  start: number;
  gain: number;
  mismatches: number;
};

function scoreApproximateOccurrence(
  source: string,
  candidate: string,
  covered: Uint8Array,
  start: number,
): ApproximateOccurrence {
  let mismatches = 0;
  let gain = 0;
  for (let offset = 0; offset < candidate.length; offset += 1) {
    if (source[start + offset] !== candidate[offset]) mismatches += 1;
    if (covered[start + offset] === 0) gain += 1;
  }
  return { start, gain, mismatches };
}

function isBetterApproximateOccurrence(
  candidate: ApproximateOccurrence,
  best: ApproximateOccurrence | null,
  allowedMismatches: number,
  minimumGain: number,
): boolean {
  if (
    candidate.mismatches > allowedMismatches ||
    candidate.gain < minimumGain
  ) {
    return false;
  }
  if (!best || candidate.mismatches < best.mismatches) return true;
  return candidate.mismatches === best.mismatches && candidate.gain > best.gain;
}

function countUncovered(
  covered: Uint8Array,
  start: number,
  length: number,
): number {
  let gain = 0;
  for (let index = start; index < start + length; index += 1) {
    if (covered[index] === 0) gain += 1;
  }
  return gain;
}

function markCovered(covered: Uint8Array, start: number, length: number): void {
  for (let index = start; index < start + length; index += 1) {
    covered[index] = 1;
  }
}

function unionBboxes(boxes: readonly BBox[]): BBox {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return {
    x: left,
    y: top,
    w: right - left,
    h: bottom - top,
  };
}

function normalizeGlyphText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

function resolveItemDirection(item: OverlayItem): "horizontal" | "vertical" {
  if (item.direction === "horizontal" || item.direction === "vertical") {
    return item.direction;
  }
  return item.bbox.w >= item.bbox.h ? "horizontal" : "vertical";
}
