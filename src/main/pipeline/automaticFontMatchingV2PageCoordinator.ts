import type {
  FontMatchingPaletteRole,
  FontMatchingSemanticRole,
  WorkTypographyProfileV2,
} from "../../shared/fontMatchingProfileTypes";
import type {
  FontMatchingDecisionResultV2,
  FontMatchingWorkStateV2,
} from "./fontMatchingDecisionV2";
import type { OverlayItem } from "./types";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "./fontMatchingPagePixelInferenceTypes";
import { createAutomaticFontChapterBodyPriorV2 } from "./automaticFontMatchingV2ChapterPrior";
import type { FontMatchingRuntimePolicy } from "./fontMatchingRuntimePolicyContract";
import {
  buildAutomaticFontPageConsistencyPlan,
  mergeAutomaticFontPageConsistencyState,
} from "./automaticFontMatchingV2PageConsistency";
import type { AutomaticFontPageConsistencyState } from "./automaticFontMatchingV2PageConsistencyShared";
import type { FontContinuityObservation } from "../../shared/translationCheckpoint";

const BODY_ANCHOR_ROLES = new Set<FontMatchingSemanticRole>([
  "dialogue",
  "narration",
  "thought",
]);

export type AutomaticFontPageCoordinatorV2 = Readonly<{
  prepareWorkState: (
    item: OverlayItem,
    role: FontMatchingSemanticRole,
    pixelInference?: VerifiedAutomaticFontPixelInferenceV2 | null,
    runtimePolicy?: FontMatchingRuntimePolicy,
  ) => FontMatchingWorkStateV2 | undefined;
  recordDecision: (
    role: FontMatchingSemanticRole,
    workState: FontMatchingWorkStateV2 | undefined,
    result: FontMatchingDecisionResultV2,
    profile: WorkTypographyProfileV2 | null,
    pixelInference?: VerifiedAutomaticFontPixelInferenceV2 | null,
    runtimePolicy?: FontMatchingRuntimePolicy,
  ) => void;
  hydrateContinuity?: (
    observations: readonly FontContinuityObservation[],
  ) => void;
  snapshotPageContinuity?: (
    pageId: string,
  ) => readonly FontContinuityObservation[];
}>;

type ChapterCoordinatorState = Readonly<{
  accentObservations: FontContinuityObservation[];
  bodyPrior: ReturnType<typeof createAutomaticFontChapterBodyPriorV2>;
  usedFontIdsByRole: Map<FontMatchingPaletteRole, Set<string>>;
}>;

/** Carry high-confidence choices between block-local decisions in one chapter. */
export function createAutomaticFontChapterCoordinatorV2(): AutomaticFontPageCoordinatorV2 {
  const state: ChapterCoordinatorState = {
    usedFontIdsByRole: new Map(),
    bodyPrior: createAutomaticFontChapterBodyPriorV2(),
    accentObservations: [],
  };

  return {
    prepareWorkState(_item, role, pixelInference, runtimePolicy) {
      if (BODY_ANCHOR_ROLES.has(role)) {
        return pixelInference
          ? state.bodyPrior.prepare(role, pixelInference, runtimePolicy)
          : undefined;
      }
      return prepareAccentWorkState({
        pixelInference,
        role,
        usedFontIdsByRole: state.usedFontIdsByRole,
      });
    },
    recordDecision(
      role,
      _workState,
      result,
      profile,
      pixelInference,
      runtimePolicy,
    ) {
      recordChapterDecision(state, {
        inference: pixelInference,
        profile,
        result,
        role,
        runtimePolicy,
      });
    },
    hydrateContinuity(observations) {
      hydrateChapterContinuity(state, observations);
    },
    snapshotPageContinuity(pageId) {
      return [
        ...state.bodyPrior.snapshotPage(pageId),
        ...state.accentObservations.filter(
          (observation) => observation.pageId === pageId,
        ),
      ];
    },
  };
}

function recordChapterDecision(
  state: ChapterCoordinatorState,
  {
    inference,
    profile,
    result,
    role,
    runtimePolicy,
  }: {
    inference?: VerifiedAutomaticFontPixelInferenceV2 | null;
    profile: WorkTypographyProfileV2 | null;
    result: FontMatchingDecisionResultV2;
    role: FontMatchingSemanticRole;
    runtimePolicy?: FontMatchingRuntimePolicy;
  },
): void {
  const selectedFontId = result.selectedStyle?.fontId;
  if (!isReusableDecision(result, selectedFontId)) return;
  if (BODY_ANCHOR_ROLES.has(role)) {
    state.bodyPrior.record(
      role,
      result,
      selectedFontId,
      inference,
      runtimePolicy,
    );
    return;
  }
  const palette = profile?.rolePalettes.find(
    (entry) => entry.role === (role as FontMatchingPaletteRole),
  );
  if (!palette?.allowedFontIds.includes(selectedFontId)) return;
  getRoleFontIds(state.usedFontIdsByRole, palette.role).add(selectedFontId);
  recordAccentObservation({
    accentObservations: state.accentObservations,
    inference,
    result,
    role,
    runtimePolicy,
    selectedFontId,
  });
}

function isReusableDecision(
  result: FontMatchingDecisionResultV2,
  selectedFontId: string | undefined,
): selectedFontId is string {
  return Boolean(
    selectedFontId &&
    result.decision.mode === "apply" &&
    result.decision.resolvedBy !== "block_user_lock" &&
    result.decision.resolvedBy !== "work_role_user_lock",
  );
}

function hydrateChapterContinuity(
  state: ChapterCoordinatorState,
  observations: readonly FontContinuityObservation[],
): void {
  state.bodyPrior.hydrate(observations);
  for (const observation of observations) {
    if (BODY_ANCHOR_ROLES.has(observation.role)) continue;
    getRoleFontIds(
      state.usedFontIdsByRole,
      observation.role as FontMatchingPaletteRole,
    ).add(observation.selectedFontId);
    appendUniqueContinuityObservation(state.accentObservations, observation);
  }
}

function getRoleFontIds(
  byRole: Map<FontMatchingPaletteRole, Set<string>>,
  role: FontMatchingPaletteRole,
): Set<string> {
  const existing = byRole.get(role);
  if (existing) return existing;
  const created = new Set<string>();
  byRole.set(role, created);
  return created;
}

type AutomaticFontPageCoordinatorOptions = Readonly<{
  chapterCoordinator?: AutomaticFontPageCoordinatorV2;
  items?: readonly OverlayItem[];
  pixelInferences?: readonly (
    | VerifiedAutomaticFontPixelInferenceV2
    | null
    | undefined
  )[];
}>;

/** Compose page-local balloon consistency with the longer-lived chapter prior. */
export function createAutomaticFontPageCoordinatorV2(
  options: AutomaticFontPageCoordinatorOptions = {},
): AutomaticFontPageCoordinatorV2 {
  const chapterCoordinator =
    options.chapterCoordinator ?? createAutomaticFontChapterCoordinatorV2();
  const pagePlan = buildAutomaticFontPageConsistencyPlan(
    options.pixelInferences ?? [],
    options.items ?? [],
  );
  return {
    prepareWorkState(item, role, pixelInference, runtimePolicy) {
      const chapterState = chapterCoordinator.prepareWorkState(
        item,
        role,
        pixelInference,
        runtimePolicy,
      );
      return mergeAutomaticFontPageConsistencyState(
        chapterState,
        pixelInference ? pagePlan.get(pixelInference.blockId) : undefined,
        runtimePolicy?.chapterPrior.localOverrideMinimumScoreMargin,
      );
    },
    recordDecision(
      role,
      workState,
      result,
      profile,
      pixelInference,
      runtimePolicy,
    ) {
      // Neutral role heads may call every block "dialogue". Never let a
      // pixel-classified display/SFX winner become the chapter body prior.
      if (
        workState?.pageBalloonConsistencyMode === "local_visual_variant" ||
        workState?.pageBalloonEmphasisMorphologyConsensus === true
      ) {
        return;
      }
      chapterCoordinator.recordDecision(
        role,
        workState,
        result,
        profile,
        pixelInference,
        runtimePolicy,
      );
    },
    hydrateContinuity(observations) {
      chapterCoordinator.hydrateContinuity?.(observations);
    },
    snapshotPageContinuity(pageId) {
      return chapterCoordinator.snapshotPageContinuity?.(pageId) ?? [];
    },
  };
}

function recordAccentObservation({
  accentObservations,
  inference,
  result,
  role,
  runtimePolicy,
  selectedFontId,
}: {
  accentObservations: FontContinuityObservation[];
  inference?: VerifiedAutomaticFontPixelInferenceV2 | null;
  result: FontMatchingDecisionResultV2;
  role: FontMatchingSemanticRole;
  runtimePolicy?: FontMatchingRuntimePolicy;
  selectedFontId: string;
}): void {
  const observation = createAccentObservation({
    inference,
    result,
    role,
    runtimePolicy,
    selectedFontId,
  });
  if (observation) {
    appendUniqueContinuityObservation(accentObservations, observation);
  }
}

function createAccentObservation({
  inference,
  result,
  role,
  runtimePolicy,
  selectedFontId,
}: Omit<Parameters<typeof recordAccentObservation>[0], "accentObservations">):
  | FontContinuityObservation
  | undefined {
  if (!inference || inference.localEvidence.noneAcceptable) return undefined;
  const localTop = [...inference.localEvidence.rankedCandidates]
    .filter((candidate) => candidate.renderStatus === "rendered")
    .sort((left, right) => left.rank - right.rank)[0];
  if (!localTop) return undefined;
  const confidence = Math.min(
    inference.localEvidence.calibratedConfidence,
    localTop.confidence,
  );
  const { minimumConfidence, minimumRoleConfidence } =
    resolveAccentMinimums(runtimePolicy);
  if (
    localTop.fontId !== selectedFontId ||
    confidence < minimumConfidence ||
    result.audit.roleConfidence < minimumRoleConfidence
  ) {
    return undefined;
  }
  return {
    pageId: inference.pageId,
    blockId: inference.blockId,
    role,
    selectedFontId,
    confidence,
    orientation: inference.treatment.orientation,
    sourceStyle: inference.sourceStyle,
    modelVersion: inference.modelVersion,
    candidateOrderSha256: inference.candidateOrderSha256,
  };
}

function resolveAccentMinimums(
  runtimePolicy: FontMatchingRuntimePolicy | undefined,
): { minimumConfidence: number; minimumRoleConfidence: number } {
  return {
    minimumConfidence:
      runtimePolicy?.automaticMutation.minimumAutomaticConfidence ?? 0.86,
    minimumRoleConfidence:
      runtimePolicy?.automaticMutation.minimumRoleConfidence ?? 0.82,
  };
}

function appendUniqueContinuityObservation(
  observations: FontContinuityObservation[],
  observation: FontContinuityObservation,
): void {
  if (
    observations.some(
      (entry) =>
        entry.pageId === observation.pageId &&
        entry.blockId === observation.blockId,
    )
  ) {
    return;
  }
  observations.push(observation);
}

function prepareAccentWorkState({
  pixelInference,
  role,
  usedFontIdsByRole,
}: {
  pixelInference?: VerifiedAutomaticFontPixelInferenceV2 | null;
  role: FontMatchingSemanticRole;
  usedFontIdsByRole: ReadonlyMap<FontMatchingPaletteRole, Set<string>>;
}): FontMatchingWorkStateV2 | undefined {
  const usedFontIds = usedFontIdsByRole.get(role as FontMatchingPaletteRole);
  if (!usedFontIds?.size && !pixelInference) return undefined;
  return {
    ...(pixelInference
      ? { automaticStrategy: "local_visual_first" as const }
      : {}),
    ...(usedFontIds?.size
      ? { rolePaletteUsedFontIds: [...usedFontIds].sort(compareStrings) }
      : {}),
  };
}

/** Resolve body anchors before page-local accent palettes, preserving source order. */
export function orderAutomaticFontMatchingPageItemIndexes(
  items: readonly OverlayItem[],
  pixelInferences: readonly (
    | VerifiedAutomaticFontPixelInferenceV2
    | null
    | undefined
  )[] = [],
): number[] {
  const pagePlan = buildAutomaticFontPageConsistencyPlan(
    pixelInferences,
    items,
  );
  return items
    .map((_item, index) => ({
      index,
      priority: resolvePageItemPriority(
        pixelInferences[index]
          ? pagePlan.get(pixelInferences[index]?.blockId ?? "")
          : undefined,
      ),
    }))
    .sort((left, right) =>
      left.priority === right.priority
        ? left.index - right.index
        : left.priority - right.priority,
    )
    .map(({ index }) => index);
}

function resolvePageItemPriority(
  pageState?: AutomaticFontPageConsistencyState,
): number {
  const mode = pageState?.mode;
  if (mode === "stable_body" || mode === "page_anchor") return 0;
  return mode === "local_visual_variant" ? 1 : 2;
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
