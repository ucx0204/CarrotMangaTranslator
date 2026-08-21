import type { PixelRect } from "./maskGeometry";
import type { SourceGlyphEvidence } from "./sourceGlyphResidual";
import type { PatternSourceGlyphEvidenceReceipt } from "./sourceGlyphEvidenceReceipt";

export const SOURCE_GLYPH_RESIDUAL_DIAGNOSTICS_CONTRACT_VERSION =
  "source-glyph-residual-diagnostics-v2" as const;
export const UNASSIGNED_OCR_RESIDUAL_PROVENANCE_CONTRACT_VERSION =
  "unassigned-ocr-residual-provenance-v1" as const;

export type SourceGlyphComponentResidualProfile = {
  maxAspectRatio: number;
  maxFillRatio: number;
  maxSourcePixelCount: number;
  minFillRatio: number;
  minLargestExactLikeRun: number;
  minLargestExactLikeRunRatio: number;
  minRetainedPixelCount: number;
  minRetainedRatio: number;
  minSourcePixelCount: number;
};

/**
 * An intentionally diagnostic-only starting point. It must be validated on a
 * work-disjoint holdout before any caller can use it as a completion veto.
 */
export const CRUDE_SOURCE_GLYPH_COMPONENT_PROFILE = Object.freeze({
  maxAspectRatio: 5,
  maxFillRatio: 0.88,
  maxSourcePixelCount: 1_600,
  minFillRatio: 0.04,
  minLargestExactLikeRun: 10,
  minLargestExactLikeRunRatio: 0.65,
  minRetainedPixelCount: 14,
  minRetainedRatio: 0.9,
  minSourcePixelCount: 14,
}) satisfies SourceGlyphComponentResidualProfile;

/**
 * Old10 refinement: rejects tiny retained specks and large dense art while
 * preserving a locally intact glyph. It remains promotion-ineligible until a
 * new work-disjoint cohort validates the shape/size cutoffs.
 */
export const REFINED_SOURCE_GLYPH_COMPONENT_PROFILE = Object.freeze({
  maxAspectRatio: 6.5,
  maxFillRatio: 0.45,
  maxSourcePixelCount: 6_000,
  minFillRatio: 0.04,
  minLargestExactLikeRun: 64,
  minLargestExactLikeRunRatio: 0.9,
  minRetainedPixelCount: 80,
  minRetainedRatio: 0.97,
  minSourcePixelCount: 120,
}) satisfies SourceGlyphComponentResidualProfile;

export type SourceGlyphComponentResidual = {
  componentIndex: number;
  bounds: PixelRect;
  sourcePixelCount: number;
  sourceFillRatio: number;
  sourceAspectRatio: number;
  sourceLikeRemainingCount: number;
  retainedRatio: number;
  largestExactLikeRun: number;
  largestExactLikeRunRatio: number;
  diagnosticCandidate: boolean;
};

export type SourceGlyphComponentResidualDiagnostic = {
  contractVersion: typeof SOURCE_GLYPH_RESIDUAL_DIAGNOSTICS_CONTRACT_VERSION;
  diagnosticOnly: true;
  promotionEligible: false;
  resolutionNormalized: false;
  sourceSeedCount: number;
  sourceLikeRemainingCount: number;
  sourceLikeRemainingRatio: number;
  sourceComponentCount: number;
  candidateComponentCount: number;
  components: SourceGlyphComponentResidual[];
};

export type UnassignedOcrResidualProvenanceInput = {
  expectedFontInputSha256: string;
  expectedOcrResultSha256: string;
  expectedSourceImageSha256: string;
  fontInputBytes: Uint8Array;
  knownSourceEvidenceByBlockId: ReadonlyMap<string, SourceGlyphEvidence>;
  ocrResultBytes: Uint8Array;
  sourceImageBytes: Uint8Array;
  sourceImagePath: string;
  sourcePageId: string;
  sourceEvidenceReceipt: PatternSourceGlyphEvidenceReceipt;
};

export type UnassignedOcrResidualProvenanceReceipt = {
  contractVersion: typeof UNASSIGNED_OCR_RESIDUAL_PROVENANCE_CONTRACT_VERSION;
  sealed: boolean;
  rejectionReasons: string[];
  sourceImagePath: string | null;
  sourcePageId: string | null;
  sourceImageSha256: string | null;
  sourceImageSchema: "raw-source-image-bytes-v1";
  sourceBitmapSha256: string | null;
  sourceDecoderContract: string | null;
  sourceEvidenceBindingSha256: string | null;
  ocrResultSha256: string | null;
  ocrResultSchemaVersion: number | null;
  fontInputSha256: string | null;
  fontInputSchemaVersion: number | null;
  assignedCandidateIds: string[];
  assignedCandidateIdsSha256: string;
  candidateMembershipSha256: string;
  bindingSha256: string;
};

export type RawOcrGlyphHint = {
  id: string | number;
  label?: unknown;
  ocrText?: unknown;
  reviewReasons?: unknown;
  reviewStatus?: unknown;
  score?: unknown;
  x1: unknown;
  x2: unknown;
  y1: unknown;
  y2: unknown;
};

export type UnassignedOcrResidualProfile = {
  componentProfile: SourceGlyphComponentResidualProfile;
  maxKnownBlockContainment: number;
  maxKnownEvidenceOverlapRatio: number;
  minHintScore: number;
  minSourceLikeRemainingRatio: number;
};

export const CRUDE_UNASSIGNED_OCR_RESIDUAL_PROFILE = Object.freeze({
  componentProfile: CRUDE_SOURCE_GLYPH_COMPONENT_PROFILE,
  maxKnownBlockContainment: 0.25,
  maxKnownEvidenceOverlapRatio: 0.15,
  minHintScore: 0.8,
  minSourceLikeRemainingRatio: 0.75,
}) satisfies UnassignedOcrResidualProfile;

export const REFINED_UNASSIGNED_OCR_RESIDUAL_PROFILE = Object.freeze({
  componentProfile: REFINED_SOURCE_GLYPH_COMPONENT_PROFILE,
  maxKnownBlockContainment: 0.25,
  maxKnownEvidenceOverlapRatio: 0.15,
  minHintScore: 0.9,
  minSourceLikeRemainingRatio: 0.9,
}) satisfies UnassignedOcrResidualProfile;

export type UnassignedOcrHintResidualDiagnostic = {
  contractVersion: typeof SOURCE_GLYPH_RESIDUAL_DIAGNOSTICS_CONTRACT_VERSION;
  diagnosticOnly: true;
  promotionEligible: false;
  resolutionNormalized: false;
  provenance: "sealed-raw-ocr-hint" | "unsealed-raw-ocr-hint";
  provenanceReceipt: UnassignedOcrResidualProvenanceReceipt;
  hintId: string;
  sourceText: string;
  score: number;
  reviewStatus: string | null;
  reviewReasons: string[];
  bounds: PixelRect;
  sourceEvidenceBounds: PixelRect;
  sourceEvidenceStrategy: SourceGlyphEvidence["strategy"];
  knownBlockContainment: number;
  knownEvidenceOverlapRatio: number;
  sourceSeedCount: number;
  sourceLikeRemainingCount: number;
  sourceLikeRemainingRatio: number;
  candidateComponentCount: number;
  diagnosticCandidate: boolean;
  rejectionReasons: string[];
  componentDiagnostic: SourceGlyphComponentResidualDiagnostic;
};
