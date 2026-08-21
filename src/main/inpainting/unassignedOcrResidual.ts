import type { InpaintingWindowMask } from "./inpaintingEngine";
import { expandRect, type PixelRect } from "./maskGeometry";
import { buildPatternTextMask } from "./patternTextMask";
import type { SourceGlyphEvidence } from "./sourceGlyphResidual";
import { measureSourceGlyphComponentResiduals } from "./sourceGlyphComponentResidual";
import {
  CRUDE_UNASSIGNED_OCR_RESIDUAL_PROFILE,
  SOURCE_GLYPH_RESIDUAL_DIAGNOSTICS_CONTRACT_VERSION,
  type RawOcrGlyphHint,
  type UnassignedOcrHintResidualDiagnostic,
  type UnassignedOcrResidualProvenanceInput,
  type UnassignedOcrResidualProvenanceReceipt,
  type UnassignedOcrResidualProfile,
} from "./sourceGlyphResidualDiagnosticTypes";
import {
  safeRatio,
  validateComponentProfile,
  validateDiagnosticBitmapContract,
  validateDiagnosticWindowMask,
  windowMaskContainsPixel,
} from "./sourceGlyphResidualDiagnosticUtils";
import { resolveUnassignedOcrProvenance } from "./unassignedOcrResidualProvenance";

const JAPANESE_TEXT_PATTERN =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

type NormalizedHint = {
  bounds: PixelRect;
  hintId: string;
  reviewReasons: string[];
  reviewStatus: string | null;
  score: number;
  sourceText: string;
};

/**
 * Builds review-only residual candidates from raw OCR hints that were not
 * assigned to a translated block. The result has no mask/deletion/retry API;
 * callers can only persist or display the diagnostics.
 */
export function measureUnassignedOcrHintResiduals(options: {
  after: Buffer;
  assignedHintIds?: ReadonlySet<string>;
  before: Buffer;
  hints?: readonly RawOcrGlyphHint[];
  knownBlockBounds?: readonly PixelRect[];
  knownSourceEvidence?: readonly SourceGlyphEvidence[];
  pageHeight: number;
  pageWidth: number;
  profile?: UnassignedOcrResidualProfile;
  provenance?: UnassignedOcrResidualProvenanceInput;
}): UnassignedOcrHintResidualDiagnostic[] {
  validateBitmapInputs(options);
  const provenance = resolveUnassignedOcrProvenance({
    after: options.after,
    assignedHintIds: options.assignedHintIds,
    before: options.before,
    hints: options.hints,
    knownBlockBounds: options.knownBlockBounds,
    knownSourceEvidence: options.knownSourceEvidence,
    pageHeight: options.pageHeight,
    pageWidth: options.pageWidth,
    provenance: options.provenance,
  });
  validateKnownEvidence(
    provenance.knownSourceEvidence,
    options.pageWidth,
    options.pageHeight,
  );
  const profile = options.profile ?? CRUDE_UNASSIGNED_OCR_RESIDUAL_PROFILE;
  validateUnassignedProfile(profile);
  const results: UnassignedOcrHintResidualDiagnostic[] = [];
  const seenIds = new Set<string>();
  for (const rawHint of provenance.hints) {
    const hint = normalizeEligibleHint(
      rawHint,
      {
        assignedHintIds: provenance.assignedHintIds,
        pageHeight: options.pageHeight,
        pageWidth: options.pageWidth,
      },
      seenIds,
    );
    if (!hint) continue;
    results.push(
      measureHint(
        {
          ...options,
          knownBlockBounds: provenance.knownBlockBounds,
          knownSourceEvidence: provenance.knownSourceEvidence,
        },
        hint,
        profile,
        provenance.receipt,
      ),
    );
  }
  return results.sort(compareHintDiagnostics);
}

function validateBitmapInputs(options: {
  after: Buffer;
  before: Buffer;
  pageHeight: number;
  pageWidth: number;
}): void {
  const actualHeight = validateDiagnosticBitmapContract(
    options.before,
    options.after,
    options.pageWidth,
  );
  if (actualHeight !== options.pageHeight) {
    throw new Error("Unassigned OCR residual page dimensions do not match.");
  }
}

function validateKnownEvidence(
  knownSourceEvidence: readonly SourceGlyphEvidence[],
  pageWidth: number,
  pageHeight: number,
): void {
  for (const evidence of knownSourceEvidence) {
    validateDiagnosticWindowMask(evidence.windowMask, pageWidth, pageHeight);
  }
}

function normalizeEligibleHint(
  rawHint: RawOcrGlyphHint,
  options: {
    assignedHintIds: ReadonlySet<string>;
    pageHeight: number;
    pageWidth: number;
  },
  seenIds: Set<string>,
): NormalizedHint | null {
  const hintId = String(rawHint.id ?? "").trim();
  const invalidIdentity =
    !hintId || seenIds.has(hintId) || options.assignedHintIds.has(hintId);
  if (invalidIdentity) return null;
  seenIds.add(hintId);
  const unsupportedLabel =
    rawHint.label !== undefined && String(rawHint.label) !== "ocr_textline";
  const sourceText = String(rawHint.ocrText ?? "").trim();
  if (unsupportedLabel || !JAPANESE_TEXT_PATTERN.test(sourceText)) return null;
  const bounds = parseHintBounds(
    rawHint,
    options.pageWidth,
    options.pageHeight,
  );
  if (!bounds) return null;
  const score = Number(rawHint.score);
  return {
    bounds,
    hintId,
    reviewReasons: stringArray(rawHint.reviewReasons),
    reviewStatus: nullableString(rawHint.reviewStatus),
    score: Number.isFinite(score) ? score : 0,
    sourceText,
  };
}

function measureHint(
  options: {
    after: Buffer;
    before: Buffer;
    knownBlockBounds: readonly PixelRect[];
    knownSourceEvidence: readonly SourceGlyphEvidence[];
    pageHeight: number;
    pageWidth: number;
  },
  hint: NormalizedHint,
  profile: UnassignedOcrResidualProfile,
  provenanceReceipt: UnassignedOcrResidualProvenanceReceipt,
): UnassignedOcrHintResidualDiagnostic {
  const sourceEvidence = buildHintSourceEvidence({
    before: options.before,
    bounds: hint.bounds,
    pageHeight: options.pageHeight,
    pageWidth: options.pageWidth,
  });
  const componentDiagnostic = measureSourceGlyphComponentResiduals({
    after: options.after,
    before: options.before,
    pageWidth: options.pageWidth,
    profile: profile.componentProfile,
    sourceEvidence,
  });
  const knownBlockContainment = maximumContainment(
    hint.bounds,
    options.knownBlockBounds,
  );
  const knownEvidenceOverlapRatio = calculateEvidenceOverlapRatio(
    sourceEvidence.windowMask,
    options.knownSourceEvidence,
  );
  const rejectionReasons = buildRejectionReasons({
    componentDiagnostic,
    hintScore: hint.score,
    knownBlockContainment,
    knownEvidenceOverlapRatio,
    profile,
    provenanceReceipt,
    sourceEvidence,
  });
  return {
    contractVersion: SOURCE_GLYPH_RESIDUAL_DIAGNOSTICS_CONTRACT_VERSION,
    diagnosticOnly: true,
    promotionEligible: false,
    resolutionNormalized: false,
    provenance: provenanceReceipt.sealed
      ? "sealed-raw-ocr-hint"
      : "unsealed-raw-ocr-hint",
    provenanceReceipt,
    hintId: hint.hintId,
    sourceText: hint.sourceText,
    score: hint.score,
    reviewStatus: hint.reviewStatus,
    reviewReasons: hint.reviewReasons,
    bounds: hint.bounds,
    sourceEvidenceBounds: sourceEvidence.windowMask.bounds,
    sourceEvidenceStrategy: sourceEvidence.strategy,
    knownBlockContainment,
    knownEvidenceOverlapRatio,
    sourceSeedCount: componentDiagnostic.sourceSeedCount,
    sourceLikeRemainingCount: componentDiagnostic.sourceLikeRemainingCount,
    sourceLikeRemainingRatio: componentDiagnostic.sourceLikeRemainingRatio,
    candidateComponentCount: componentDiagnostic.candidateComponentCount,
    diagnosticCandidate:
      provenanceReceipt.sealed && rejectionReasons.length === 0,
    rejectionReasons,
    componentDiagnostic,
  };
}

function buildRejectionReasons(options: {
  componentDiagnostic: ReturnType<typeof measureSourceGlyphComponentResiduals>;
  hintScore: number;
  knownBlockContainment: number;
  knownEvidenceOverlapRatio: number;
  profile: UnassignedOcrResidualProfile;
  provenanceReceipt: UnassignedOcrResidualProvenanceReceipt;
  sourceEvidence: SourceGlyphEvidence;
}): string[] {
  const reasons: string[] = [];
  reasons.push(...options.provenanceReceipt.rejectionReasons);
  if (options.hintScore < options.profile.minHintScore) {
    reasons.push("hint-score-below-profile");
  }
  if (options.sourceEvidence.strategy === "none") {
    reasons.push("no-source-glyph-evidence");
  }
  if (
    options.componentDiagnostic.sourceLikeRemainingRatio <
    options.profile.minSourceLikeRemainingRatio
  ) {
    reasons.push("source-retention-below-profile");
  }
  if (options.componentDiagnostic.candidateComponentCount === 0) {
    reasons.push("no-retained-glyph-component");
  }
  if (
    options.knownBlockContainment > options.profile.maxKnownBlockContainment
  ) {
    reasons.push("overlaps-known-block");
  }
  if (
    options.knownEvidenceOverlapRatio >
    options.profile.maxKnownEvidenceOverlapRatio
  ) {
    reasons.push("overlaps-known-source-evidence");
  }
  return reasons;
}

function buildHintSourceEvidence(options: {
  before: Buffer;
  bounds: PixelRect;
  pageHeight: number;
  pageWidth: number;
}): SourceGlyphEvidence {
  const margin = Math.max(
    2,
    Math.min(
      12,
      Math.round(Math.min(options.bounds.w, options.bounds.h) * 0.08),
    ),
  );
  const evidenceBounds = expandRect(
    options.bounds,
    options.pageWidth,
    options.pageHeight,
    margin,
  );
  const detected = buildPatternTextMask(
    options.before,
    options.pageWidth,
    options.pageHeight,
    evidenceBounds,
    0,
    { focusRect: options.bounds },
  );
  return {
    strategy: detected.strategy,
    windowMask: { bounds: evidenceBounds, data: detected.mask },
  };
}

function calculateEvidenceOverlapRatio(
  source: InpaintingWindowMask,
  known: readonly SourceGlyphEvidence[],
): number {
  let sourceCount = 0;
  let overlapCount = 0;
  for (let y = 0; y < source.bounds.h; y += 1) {
    for (let x = 0; x < source.bounds.w; x += 1) {
      if (!source.data[y * source.bounds.w + x]) continue;
      sourceCount += 1;
      const pageX = source.bounds.x + x;
      const pageY = source.bounds.y + y;
      if (
        known.some((entry) =>
          windowMaskContainsPixel(entry.windowMask, pageX, pageY),
        )
      ) {
        overlapCount += 1;
      }
    }
  }
  return safeRatio(overlapCount, sourceCount);
}

function maximumContainment(
  inner: PixelRect,
  outers: readonly PixelRect[],
): number {
  const innerArea = inner.w * inner.h;
  return outers.reduce((maximum, outer) => {
    const width = Math.max(
      0,
      Math.min(inner.x + inner.w, outer.x + outer.w) -
        Math.max(inner.x, outer.x),
    );
    const height = Math.max(
      0,
      Math.min(inner.y + inner.h, outer.y + outer.h) -
        Math.max(inner.y, outer.y),
    );
    return Math.max(maximum, safeRatio(width * height, innerArea));
  }, 0);
}

function parseHintBounds(
  hint: RawOcrGlyphHint,
  pageWidth: number,
  pageHeight: number,
): PixelRect | null {
  const raw = [hint.x1, hint.y1, hint.x2, hint.y2].map(Number);
  if (!raw.every(Number.isFinite)) return null;
  const x1 = clamp(Math.floor(raw[0]), 0, pageWidth);
  const y1 = clamp(Math.floor(raw[1]), 0, pageHeight);
  const x2 = clamp(Math.ceil(raw[2]), 0, pageWidth);
  const y2 = clamp(Math.ceil(raw[3]), 0, pageHeight);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
}

function validateUnassignedProfile(
  profile: UnassignedOcrResidualProfile,
): void {
  validateComponentProfile(profile.componentProfile);
  const ratios = [
    profile.maxKnownBlockContainment,
    profile.maxKnownEvidenceOverlapRatio,
    profile.minHintScore,
    profile.minSourceLikeRemainingRatio,
  ];
  if (
    ratios.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
  ) {
    throw new Error("Invalid unassigned OCR residual diagnostic profile.");
  }
}

function compareHintDiagnostics(
  left: UnassignedOcrHintResidualDiagnostic,
  right: UnassignedOcrHintResidualDiagnostic,
): number {
  return (
    Number(right.diagnosticCandidate) - Number(left.diagnosticCandidate) ||
    right.sourceLikeRemainingRatio - left.sourceLikeRemainingRatio ||
    right.score - left.score ||
    left.bounds.y - right.bounds.y ||
    left.bounds.x - right.bounds.x ||
    left.hintId.localeCompare(right.hintId)
  );
}

function nullableString(value: unknown): string | null {
  const result = String(value ?? "").trim();
  return result || null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter(Boolean)
    : [];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
