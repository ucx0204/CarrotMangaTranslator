import type { MangaPage } from "../../shared/libraryTypes";
import type {
  FontMatchingSemanticRole,
  WorkTypographyProfileV2,
} from "../../shared/fontMatchingProfileTypes";
import { FONT_MATCHING_SEMANTIC_ROLES } from "../../shared/fontMatchingProfileTypes";
import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import type { FontMatchingRuntimeArtifactStatus } from "./fontMatchingRuntimeArtifactStatus";
import type {
  FontMatchingInferenceInputBoundary,
  VerifiedAutomaticFontPixelInferenceV2,
} from "./fontMatchingPagePixelInferenceTypes";

export function resolveVerifiedPixelInference({
  block,
  candidates,
  inference,
  page,
  status,
}: {
  block: TranslationBlock;
  candidates: readonly AutomaticFontCandidate[];
  inference?: VerifiedAutomaticFontPixelInferenceV2;
  page: MangaPage;
  status?: FontMatchingRuntimeArtifactStatus;
}): VerifiedAutomaticFontPixelInferenceV2 | null {
  return resolveVerifiedPixelInferenceForBlockId({
    blockId: block.id,
    candidates,
    inference,
    page,
    status,
  });
}

/**
 * Validate page inference before a TranslationBlock exists. Page-level
 * coordination must never consume an inference merely because its static type
 * says "verified"; the runtime artifact and page/block identity are the trust
 * boundary.
 */
export function resolveVerifiedPixelInferenceForBlockId({
  blockId,
  candidates,
  inference,
  page,
  status,
}: {
  blockId: string;
  candidates: readonly AutomaticFontCandidate[];
  inference?: VerifiedAutomaticFontPixelInferenceV2;
  page: MangaPage;
  status?: FontMatchingRuntimeArtifactStatus;
}): VerifiedAutomaticFontPixelInferenceV2 | null {
  if (status?.state !== "ready" || !inference) return null;
  if (
    !validPixelInferenceIdentity(inference, status, blockId, page) ||
    !validPixelInferenceEvidence(inference, status, candidates)
  ) {
    return null;
  }
  return inference;
}

export function resolveManualUserLocks(
  profile: WorkTypographyProfileV2 | null,
  workId: string,
  chapterId: string,
  pageId: string,
  blockId: string,
  role: FontMatchingSemanticRole,
) {
  if (!profile || profile.workId !== workId) {
    return { block: null, role: null } as const;
  }
  const block = profile.userLocks.find(
    (lock) =>
      lock.scope.type === "block" &&
      lock.scope.chapterId === chapterId &&
      lock.scope.pageId === pageId &&
      lock.scope.blockId === blockId,
  )?.selection;
  const roleLock = profile.userLocks.find(
    (lock) => lock.scope.type === "role" && lock.scope.role === role,
  )?.selection;
  return { block: block ?? null, role: roleLock ?? null } as const;
}

function validPixelInferenceIdentity(
  inference: VerifiedAutomaticFontPixelInferenceV2,
  status: Extract<FontMatchingRuntimeArtifactStatus, { state: "ready" }>,
  blockId: string,
  page: MangaPage,
): boolean {
  return (
    status.automaticMutationAllowed &&
    inference.pageId === page.id &&
    inference.blockId === blockId
  );
}

function validPixelInferenceEvidence(
  inference: VerifiedAutomaticFontPixelInferenceV2,
  status: Extract<FontMatchingRuntimeArtifactStatus, { state: "ready" }>,
  candidates: readonly AutomaticFontCandidate[],
): boolean {
  return (
    inference.modelVersion === status.modelVersion &&
    inference.localEvidence.modelVersion === status.modelVersion &&
    inference.candidateOrderSha256 === status.candidateOrderSha256 &&
    inference.localEvidence.catalogVersion === status.catalogVersion &&
    validRuntimeInputBoundary(inference.inputBoundary) &&
    validSelectionCalibrationAudit(inference) &&
    validSemanticEvidence(inference) &&
    sameCandidateSet(
      candidates.map((candidate) => candidate.fontId),
      status.candidateIds,
    ) &&
    sameCandidateSet(
      inference.localEvidence.rankedCandidates.map((entry) => entry.fontId),
      status.candidateIds,
    )
  );
}

// eslint-disable-next-line complexity -- the sealed audit tuple is validated as one boundary
function validSelectionCalibrationAudit(
  inference: VerifiedAutomaticFontPixelInferenceV2,
): boolean {
  const audit = inference.selectionCalibration;
  const reasons = [
    "none_acceptable",
    "severe_input_invalid",
    "feature_boundary_invalid",
    "invalid_calibrated_score",
    "score_below_operating_point",
    "no_renderable_top3",
  ];
  const families = ["body", "variant", "global"];
  return (
    typeof audit.applied === "boolean" &&
    isProbability(audit.globalRiskLowerConfidenceBound) &&
    (audit.selectionScore === null || isProbability(audit.selectionScore)) &&
    (audit.fallbackReason === null || reasons.includes(audit.fallbackReason)) &&
    (audit.operatingFamily === null ||
      families.includes(audit.operatingFamily)) &&
    (audit.applied
      ? audit.fallbackReason === null &&
        audit.operatingFamily !== null &&
        audit.selectionScore !== null
      : audit.fallbackReason !== null && audit.operatingFamily === null)
  );
}

function validRuntimeInputBoundary(
  boundary: FontMatchingInferenceInputBoundary,
): boolean {
  return (
    boundary.source === "user_page" &&
    boundary.datasetSplit === null &&
    boundary.qaOverlay === false
  );
}

function validSemanticEvidence(
  inference: VerifiedAutomaticFontPixelInferenceV2,
): boolean {
  const role = inference.rolePrediction;
  const style = inference.sourceStyle;
  const treatment = inference.treatment;
  return (
    isSemanticRole(role.primary) &&
    isProbability(role.confidence) &&
    role.alternatives.every(
      (entry) => isSemanticRole(entry.role) && isProbability(entry.confidence),
    ) &&
    [
      style.serifness,
      style.weight,
      style.width,
      style.roundness,
      style.strokeContrast,
      style.handwritten,
      style.angularity,
      style.irregularity,
      style.slant,
      style.energy,
    ].every((value) => value === null || isProbability(value)) &&
    ["horizontal", "vertical"].includes(treatment.orientation) &&
    ["none", "single", "multiple", "unknown"].includes(treatment.outline) &&
    ["none", "hard", "soft", "unknown"].includes(treatment.shadow) &&
    ["solid", "gradient", "pattern", "unknown"].includes(treatment.fill) &&
    ["none", "perspective", "curved", "warped", "unknown"].includes(
      treatment.distortion,
    ) &&
    ["normal", "inverse", "unknown"].includes(treatment.polarity) &&
    ["monochrome", "color", "unknown"].includes(treatment.colorMode)
  );
}

function isSemanticRole(value: string): value is FontMatchingSemanticRole {
  return (FONT_MATCHING_SEMANTIC_ROLES as readonly string[]).includes(value);
}

function isProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function sameCandidateSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value))
  );
}
