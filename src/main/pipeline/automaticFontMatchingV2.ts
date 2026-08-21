import type { MangaPage } from "../../shared/libraryTypes";
import type {
  FontMatchingSemanticRole,
  FontMatchRolePredictionV2,
  WorkTypographyProfileV2,
} from "../../shared/fontMatchingProfileTypes";
import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import { resolveUiLocale } from "../../shared/uiLocales";
import {
  resolveFontMatchingDecisionV2,
  type BlockLocalFontEvidenceV2,
  type FontMatchingDecisionResultV2,
  type TranslationFontAssessmentV2,
} from "./fontMatchingDecisionV2";
import type { OverlayItem } from "./types";
import {
  FONT_MATCHING_V2_MODEL_VERSION,
  FONT_MATCHING_V2_RENDERER_HASH,
} from "./automaticFontMatchingV2Catalog";
import type { AutomaticFontPageCoordinatorV2 } from "./automaticFontMatchingV2PageCoordinator";
import type { FontMatchingRuntimeArtifactStatus } from "./fontMatchingRuntimeArtifactStatus";
import type { FontMatchingRuntimePolicy } from "./fontMatchingRuntimePolicyContract";
import {
  resolveManualUserLocks,
  resolveVerifiedPixelInference,
} from "./automaticFontMatchingV2RuntimeGate";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "./fontMatchingPagePixelInferenceTypes";
import { resolveCombinedAutomaticFontRole } from "./automaticFontMatchingV2Role";
import { resolveAutomaticFontCandidateWidthScale } from "./automaticFontMatchingV2CandidateAssessment";
import { resolveAutomaticDecisionCalibration } from "./automaticFontMatchingV2DecisionCalibration";
import { applyAutomaticPixelStyle } from "./automaticFontMatchingV2Style";
import { prepareAutomaticFontEvidence } from "./automaticFontMatchingV2Evidence";
import {
  resolveAutomaticInverseTextStyle,
  type AutomaticInverseTextStyleV1,
} from "./automaticFontMatchingV2Polarity";

export {
  FONT_MATCHING_V2_MODEL_VERSION,
  FONT_MATCHING_V2_RENDERER_HASH,
  resolveFontMatchingV2CatalogVersion,
} from "./automaticFontMatchingV2Catalog";
/**
 * These values identify the production font faces and renderer used to build
 * the first V2 prototype bank. A profile from a different bank must abstain
 * instead of silently applying stale font ids.
 */
export type AutomaticFontOptionsV2 = Readonly<{
  enabled?: boolean;
  targetLanguage?: string;
  workId?: string;
  chapterId?: string;
  profile?: WorkTypographyProfileV2 | null;
  candidates?: readonly AutomaticFontCandidate[];
  pageCoordinator?: AutomaticFontPageCoordinatorV2;
  runtimeArtifactStatus?: FontMatchingRuntimeArtifactStatus;
  pixelInference?: VerifiedAutomaticFontPixelInferenceV2;
}>;

export type AutomaticFontDecisionV2 = Readonly<{
  result: FontMatchingDecisionResultV2;
  role: FontMatchRolePredictionV2;
  fontMetricWidthScale?: number;
  inverseTextStyle?: AutomaticInverseTextStyleV1;
}>;

export function resolveAutomaticFontDecisionV2({
  block,
  item,
  page,
  options,
}: {
  block: TranslationBlock;
  item: OverlayItem;
  page: MangaPage;
  options: AutomaticFontOptionsV2;
}): AutomaticFontDecisionV2 | undefined {
  const runtime = resolveAutomaticFontRuntime(options);
  if (!runtime) return undefined;
  return resolveAutomaticFontRuntimeDecision({
    block,
    item,
    options,
    page,
    runtime,
  });
}

function resolveAutomaticFontRuntimeDecision({
  block,
  item,
  options,
  page,
  runtime,
}: {
  block: TranslationBlock;
  item: OverlayItem;
  options: AutomaticFontOptionsV2;
  page: MangaPage;
  runtime: NonNullable<ReturnType<typeof resolveAutomaticFontRuntime>>;
}): AutomaticFontDecisionV2 {
  const { candidates, chapterId, locale, profile, workId } = runtime;

  const pixelInference = resolveVerifiedPixelInference({
    block,
    candidates,
    inference: options.pixelInference,
    page,
    status: options.runtimeArtifactStatus,
  });
  const role = resolveCombinedAutomaticFontRole(
    item,
    pixelInference?.rolePrediction ?? null,
  );
  const runtimePolicy = resolveReadyRuntimePolicy(
    options.runtimeArtifactStatus,
  );
  const automaticMutationReady = Boolean(pixelInference && runtimePolicy);
  const workState = prepareAutomaticFontWorkState(
    options,
    item,
    role,
    pixelInference,
    runtimePolicy,
  );
  const manualLocks = resolveManualUserLocks(
    profile,
    workId,
    chapterId,
    page.id,
    block.id,
    role.primary,
  );
  const evidence = prepareAutomaticFontEvidence({
    block,
    candidates,
    locale,
    pixelInference,
    role,
    runtimePolicy,
    workState,
  });
  const baseResult = resolveAutomaticPolicyDecision({
    automaticMutationReady,
    block,
    candidates,
    chapterId,
    ...evidence,
    manualLocks,
    page,
    pixelInference,
    profile,
    role,
    runtimePolicy,
    workId,
    workState,
  });
  return finalizeAutomaticFontDecision({
    automaticMutationReady,
    baseResult,
    candidates,
    options,
    pixelInference,
    profile,
    role,
    runtimePolicy,
    workState,
  });
}

function finalizeAutomaticFontDecision({
  automaticMutationReady,
  baseResult,
  candidates,
  options,
  pixelInference,
  profile,
  role,
  runtimePolicy,
  workState,
}: {
  automaticMutationReady: boolean;
  baseResult: FontMatchingDecisionResultV2;
  candidates: readonly AutomaticFontCandidate[];
  options: AutomaticFontOptionsV2;
  pixelInference: VerifiedAutomaticFontPixelInferenceV2 | null;
  profile: WorkTypographyProfileV2 | null;
  role: FontMatchRolePredictionV2;
  runtimePolicy: FontMatchingRuntimePolicy | null;
  workState: ReturnType<AutomaticFontPageCoordinatorV2["prepareWorkState"]>;
}): AutomaticFontDecisionV2 {
  const result = applyAutomaticPixelStyle({
    pixelInference,
    result: baseResult,
    workState,
  });
  recordAutomaticDecision({
    automaticMutationReady,
    options,
    profile,
    result,
    role: role.primary,
    runtimePolicy,
    workState,
  });
  return buildAutomaticFontDecision(result, role, candidates, pixelInference);
}

function prepareAutomaticFontWorkState(
  options: AutomaticFontOptionsV2,
  item: OverlayItem,
  role: FontMatchRolePredictionV2,
  pixelInference: VerifiedAutomaticFontPixelInferenceV2 | null,
  runtimePolicy: FontMatchingRuntimePolicy | null,
) {
  return pixelInference
    ? options.pageCoordinator?.prepareWorkState(
        item,
        role.primary,
        pixelInference,
        runtimePolicy ?? undefined,
      )
    : undefined;
}

function resolveAutomaticPolicyDecision({
  automaticMutationReady,
  block,
  candidates,
  catalogVersion,
  chapterId,
  manualLocks,
  page,
  pixelInference,
  profile,
  rankedCandidates,
  role,
  runtimePolicy,
  translationAssessments,
  workId,
  workState,
}: {
  automaticMutationReady: boolean;
  block: TranslationBlock;
  candidates: readonly AutomaticFontCandidate[];
  catalogVersion: string;
  chapterId: string;
  manualLocks: ReturnType<typeof resolveManualUserLocks>;
  page: MangaPage;
  pixelInference: VerifiedAutomaticFontPixelInferenceV2 | null;
  profile: WorkTypographyProfileV2 | null;
  rankedCandidates: BlockLocalFontEvidenceV2["rankedCandidates"];
  role: FontMatchRolePredictionV2;
  runtimePolicy: FontMatchingRuntimePolicy | null;
  translationAssessments: readonly TranslationFontAssessmentV2[];
  workId: string;
  workState: ReturnType<AutomaticFontPageCoordinatorV2["prepareWorkState"]>;
}): FontMatchingDecisionResultV2 {
  return resolveFontMatchingDecisionV2({
    workId,
    chapterId,
    pageId: page.id,
    blockId: block.id,
    role,
    treatment: {
      orientation:
        pixelInference?.treatment.orientation ?? block.renderDirection,
    },
    localEvidence: pixelInference
      ? {
          ...pixelInference.localEvidence,
          rankedCandidates,
          supervisedSelectionAccepted:
            pixelInference.selectionCalibration.applied,
          bestAvailableSelectionRequired:
            !pixelInference.selectionCalibration.applied &&
            pixelInference.localEvidence.rankedCandidates.some(
              (candidate) => candidate.renderStatus === "rendered",
            ),
        }
      : {
          rankedCandidates,
          // Semantic ranking is audit-only and cannot unlock profiles or mutation.
          calibratedConfidence: 0,
          supervisedSelectionAccepted: false,
          bestAvailableSelectionRequired: false,
          noneAcceptable: false,
          catalogVersion,
          modelVersion: FONT_MATCHING_V2_MODEL_VERSION,
          rendererHash: FONT_MATCHING_V2_RENDERER_HASH,
        },
    translationAssessments,
    profile: automaticMutationReady ? profile : null,
    blockUserLock: manualLocks.block,
    workRoleUserLock: manualLocks.role,
    ...(workState ? { workState } : {}),
    userDefaultCandidate: resolveUserDefaultCandidate(block, candidates),
    calibration: resolveAutomaticDecisionCalibration(
      runtimePolicy,
      pixelInference,
    ),
  });
}

function recordAutomaticDecision({
  automaticMutationReady,
  options,
  profile,
  result,
  role,
  runtimePolicy,
  workState,
}: {
  automaticMutationReady: boolean;
  options: AutomaticFontOptionsV2;
  profile: WorkTypographyProfileV2 | null;
  result: FontMatchingDecisionResultV2;
  role: FontMatchingSemanticRole;
  runtimePolicy: FontMatchingRuntimePolicy | null;
  workState: ReturnType<AutomaticFontPageCoordinatorV2["prepareWorkState"]>;
}): void {
  if (!automaticMutationReady) return;
  options.pageCoordinator?.recordDecision(
    role,
    workState,
    result,
    profile,
    options.pixelInference,
    runtimePolicy ?? undefined,
  );
}

function resolveReadyRuntimePolicy(
  status: FontMatchingRuntimeArtifactStatus | undefined,
): FontMatchingRuntimePolicy | null {
  return status?.state === "ready" ? status.policy : null;
}

function resolveAutomaticFontRuntime(options: AutomaticFontOptionsV2) {
  if (!options.enabled) return null;
  const locale = resolveUiLocale(options.targetLanguage);
  const candidates = options.candidates ?? [];
  if (!locale || candidates.length === 0) return null;
  return {
    candidates,
    locale,
    profile: options.profile ?? null,
    workId: options.workId ?? "unscoped-work",
    chapterId: options.chapterId ?? "unscoped-chapter",
  };
}

function resolveUserDefaultCandidate(
  block: TranslationBlock,
  candidates: readonly AutomaticFontCandidate[],
) {
  return block.fontFamily
    ? { fontId: block.fontFamily }
    : resolveCatalogDefault(candidates);
}

function buildAutomaticFontDecision(
  result: FontMatchingDecisionResultV2,
  role: FontMatchRolePredictionV2,
  candidates: readonly AutomaticFontCandidate[],
  pixelInference: VerifiedAutomaticFontPixelInferenceV2 | null,
): AutomaticFontDecisionV2 {
  const selected = result.selectedStyle?.fontId;
  const candidate = selected
    ? candidates.find((entry) => entry.fontId === selected)
    : undefined;
  const inverseTextStyle = resolveAutomaticInverseTextStyle(
    pixelInference?.glyphMorphology,
  );
  return {
    result,
    role,
    ...(candidate
      ? {
          fontMetricWidthScale:
            resolveAutomaticFontCandidateWidthScale(candidate),
        }
      : {}),
    ...(inverseTextStyle ? { inverseTextStyle } : {}),
  };
}

function resolveCatalogDefault(candidates: readonly AutomaticFontCandidate[]) {
  const candidate =
    candidates.find((entry) => entry.defaultFont) ??
    [...candidates].sort(
      (left, right) =>
        left.preferenceRank - right.preferenceRank ||
        compareStrings(left.fontId, right.fontId),
    )[0];
  return candidate ? { fontId: candidate.fontId } : null;
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
