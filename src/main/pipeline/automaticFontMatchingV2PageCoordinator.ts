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
}>;

/** Carry high-confidence choices between block-local decisions in one chapter. */
export function createAutomaticFontChapterCoordinatorV2(): AutomaticFontPageCoordinatorV2 {
  const usedFontIdsByRole = new Map<FontMatchingPaletteRole, Set<string>>();
  const bodyPrior = createAutomaticFontChapterBodyPriorV2();

  return {
    prepareWorkState(_item, role, pixelInference, runtimePolicy) {
      if (BODY_ANCHOR_ROLES.has(role)) {
        return pixelInference
          ? bodyPrior.prepare(role, pixelInference, runtimePolicy)
          : undefined;
      }
      return prepareAccentWorkState({
        pixelInference,
        role,
        usedFontIdsByRole,
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
      const selectedFontId = result.selectedStyle?.fontId;
      if (
        !selectedFontId ||
        result.decision.mode !== "apply" ||
        result.decision.resolvedBy === "block_user_lock" ||
        result.decision.resolvedBy === "work_role_user_lock"
      ) {
        return;
      }
      if (BODY_ANCHOR_ROLES.has(role)) {
        bodyPrior.record(
          role,
          result,
          selectedFontId,
          pixelInference,
          runtimePolicy,
        );
        return;
      }
      const palette = profile?.rolePalettes.find(
        (entry) => entry.role === (role as FontMatchingPaletteRole),
      );
      if (!palette?.allowedFontIds.includes(selectedFontId)) return;

      let usedFontIds = usedFontIdsByRole.get(palette.role);
      if (!usedFontIds) {
        usedFontIds = new Set<string>();
        usedFontIdsByRole.set(palette.role, usedFontIds);
      }
      usedFontIds.add(selectedFontId);
    },
  };
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
  };
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
