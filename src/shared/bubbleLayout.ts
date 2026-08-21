/**
 * Shape-aware text layout metadata for a detected speech balloon.
 *
 * Span coordinates are logical, block-local ratios relative to
 * `renderBbox ?? bbox`:
 *  - horizontal text: block axis = y, inline axis = x
 *  - vertical text: block axis = x, inline axis = y
 *
 * `regions` are stored in reading order. Keeping regions separate allows a
 * single TranslationBlock to describe two connected balloon lobes whose
 * usable inline intervals overlap on the block axis.
 */
export type BubbleShapeSpan = {
  blockStart: number;
  blockEnd: number;
  inlineStart: number;
  inlineEnd: number;
};

export type BubbleShapeRegion = {
  /** Ordered, non-overlapping bands within this region. */
  spans: BubbleShapeSpan[];
};

type BubbleLayoutOrigin = "detected" | "manual";

export type BubbleLayout = {
  version: 1;
  /** Logical-axis direction for which the spans were generated. */
  direction: "horizontal" | "vertical";
  /** Detector confidence. Rendering policy may choose its own threshold. */
  confidence: number;
  /**
   * Authorship is authoritative. It is optional only for projects written
   * before provenance was introduced.
   */
  origin?: BubbleLayoutOrigin;
  /** Detector/tool identifier. Manual layouts do not need one. */
  modelId?: string;
  /** Detector input revision. Manual geometry must not carry one. */
  sourceImageRevision?: string;
  /**
   * Inset used while generating the spans. Spans already include this inset;
   * consumers must not apply it a second time.
   */
  insetRatio: number;
  /** Reading-order regions; separate entries support fused balloon lobes. */
  regions: BubbleShapeRegion[];
};

export const MAX_BUBBLE_LAYOUT_REGIONS = 4;
export const MAX_BUBBLE_REGION_SPANS = 256;
export const MAX_BUBBLE_LAYOUT_METADATA_LENGTH = 200;
export const MAX_BUBBLE_LAYOUT_INSET_RATIO = 0.49;

const BUBBLE_LAYOUT_KEYS = new Set([
  "version",
  "direction",
  "confidence",
  "origin",
  "modelId",
  "sourceImageRevision",
  "insetRatio",
  "regions",
]);
const BUBBLE_REGION_KEYS = new Set(["spans"]);
const BUBBLE_SPAN_KEYS = new Set([
  "blockStart",
  "blockEnd",
  "inlineStart",
  "inlineEnd",
]);

/**
 * Lightweight runtime guard for renderer/main fallbacks that should not need
 * to import the Zod IPC schema. This checks structure, bounds, ordering, and
 * strict object keys; confidence thresholds remain a caller policy.
 */
export function isUsableBubbleLayout(value: unknown): value is BubbleLayout {
  if (!isExactRecord(value, BUBBLE_LAYOUT_KEYS)) return false;
  return hasUsableBubbleMetadata(value) && hasUsableBubbleRegions(value);
}

/** True only for explicitly user-authored geometry. */
export function isManualBubbleLayout(
  value: BubbleLayout | null | undefined,
): boolean {
  return value?.origin === "manual";
}

/**
 * Generated layouts created before `origin` existed are recognized by the
 * reserved production model prefix so stale clearing remains compatible.
 */
export function isGeneratedBubbleLayout(
  value: BubbleLayout | null | undefined,
): boolean {
  if (!value || value.origin === "manual") return false;
  if (value.origin === "detected") return true;
  const modelId = value.modelId ?? "";
  return (
    modelId.startsWith("koharu-layout-rfdetr-") ||
    // Legacy ids are recognized only so stale stored geometry can be cleared.
    // No legacy detector is imported or invoked.
    modelId.startsWith("comic-rtdetr-")
  );
}

function hasUsableBubbleMetadata(value: Record<string, unknown>): boolean {
  return (
    hasUsableBubbleCoreMetadata(value) &&
    hasUsableBubbleTextMetadata(value) &&
    hasUsableBubbleProvenance(value)
  );
}

function hasUsableBubbleCoreMetadata(value: Record<string, unknown>): boolean {
  const validDirection =
    value.direction === "horizontal" || value.direction === "vertical";
  const validOrigin =
    value.origin === undefined ||
    value.origin === "detected" ||
    value.origin === "manual";
  const validInset =
    isFiniteNumber(value.insetRatio) &&
    value.insetRatio >= 0 &&
    value.insetRatio <= MAX_BUBBLE_LAYOUT_INSET_RATIO;
  return (
    value.version === 1 &&
    validDirection &&
    validOrigin &&
    isRatio(value.confidence) &&
    validInset
  );
}

function hasUsableBubbleTextMetadata(value: Record<string, unknown>): boolean {
  return (
    isOptionalBoundedText(value.modelId) &&
    isOptionalBoundedText(value.sourceImageRevision)
  );
}

function hasUsableBubbleProvenance(value: Record<string, unknown>): boolean {
  if (value.origin === "detected") {
    return (
      isBoundedText(value.modelId) && isBoundedText(value.sourceImageRevision)
    );
  }
  if (value.origin === "manual") {
    return value.sourceImageRevision === undefined;
  }
  return true;
}

function hasUsableBubbleRegions(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.regions) &&
    value.regions.length >= 1 &&
    value.regions.length <= MAX_BUBBLE_LAYOUT_REGIONS &&
    value.regions.every(isUsableBubbleRegion)
  );
}

function isUsableBubbleRegion(value: unknown): value is BubbleShapeRegion {
  if (!isExactRecord(value, BUBBLE_REGION_KEYS)) return false;
  if (
    !Array.isArray(value.spans) ||
    value.spans.length < 1 ||
    value.spans.length > MAX_BUBBLE_REGION_SPANS
  ) {
    return false;
  }
  let previousBlockEnd = 0;
  for (const [index, span] of value.spans.entries()) {
    if (!isUsableBubbleSpan(span)) return false;
    if (index > 0 && span.blockStart < previousBlockEnd) return false;
    previousBlockEnd = span.blockEnd;
  }
  return true;
}

function isUsableBubbleSpan(value: unknown): value is BubbleShapeSpan {
  if (!isExactRecord(value, BUBBLE_SPAN_KEYS)) return false;
  return (
    isRatio(value.blockStart) &&
    isRatio(value.blockEnd) &&
    isRatio(value.inlineStart) &&
    isRatio(value.inlineEnd) &&
    value.blockStart < value.blockEnd &&
    value.inlineStart < value.inlineEnd
  );
}

function isOptionalBoundedText(value: unknown): boolean {
  return value === undefined || isBoundedText(value);
}

function isBoundedText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_BUBBLE_LAYOUT_METADATA_LENGTH
  );
}

function isRatio(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isExactRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowedKeys.has(key))
  );
}
