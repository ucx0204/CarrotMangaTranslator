import type {
  FontMatchingPaletteRole,
  FontMatchingSemanticRole,
  WorkTypographyProfileV2,
} from "../../shared/fontMatchingProfileTypes";
import { FONT_MATCHING_SEMANTIC_ROLES } from "../../shared/fontMatchingProfileTypes";
import type {
  FontMatchingDecisionResultV2,
  FontMatchingWorkStateV2,
} from "./fontMatchingDecisionV2";
import type { OverlayItem } from "./types";
import { normalizeVisualClusterId } from "../../shared/visualClusterId";

const BODY_ANCHOR_ROLES = new Set<FontMatchingSemanticRole>([
  "dialogue",
  "narration",
  "thought",
]);

const ACCENT_PAGE_ROLES = new Set<FontMatchingSemanticRole>([
  "whisper",
  "aside_balloon_edge",
  "emphasis_dialogue",
  "shout",
  "sfx_impact",
  "sfx_motion",
  "sfx_ambient",
  "sfx_emotion",
  "sfx_comic",
]);

const DERIVED_VISUAL_CLUSTER_ROLES = new Set<FontMatchingSemanticRole>([
  "emphasis_dialogue",
  "shout",
  "sfx_impact",
  "sfx_motion",
  "sfx_ambient",
  "sfx_emotion",
  "sfx_comic",
]);

export type AutomaticFontPageCoordinatorV2 = Readonly<{
  prepareWorkState: (
    item: OverlayItem,
    role: FontMatchingSemanticRole,
  ) => FontMatchingWorkStateV2 | undefined;
  recordDecision: (
    role: FontMatchingSemanticRole,
    workState: FontMatchingWorkStateV2 | undefined,
    result: FontMatchingDecisionResultV2,
    profile: WorkTypographyProfileV2 | null,
  ) => void;
}>;

/** Carry successful palette choices between block-local decisions on one page. */
export function createAutomaticFontPageCoordinatorV2(): AutomaticFontPageCoordinatorV2 {
  const fontByVisualCluster = new Map<string, string>();
  const usedFontIdsByRole = new Map<FontMatchingPaletteRole, Set<string>>();

  return {
    prepareWorkState(item, role) {
      if (BODY_ANCHOR_ROLES.has(role)) return undefined;
      const visualClusterId = resolveVisualClusterId(item, role);
      const usedFontIds = usedFontIdsByRole.get(
        role as FontMatchingPaletteRole,
      );
      if (!visualClusterId && !usedFontIds?.size) return undefined;
      const visualClusterFontId = visualClusterId
        ? (fontByVisualCluster.get(clusterStateKey(role, visualClusterId)) ??
          null)
        : null;
      return {
        ...(visualClusterId ? { visualClusterId } : {}),
        ...(visualClusterFontId ? { visualClusterFontId } : {}),
        ...(usedFontIds?.size
          ? { rolePaletteUsedFontIds: [...usedFontIds].sort(compareStrings) }
          : {}),
      };
    },
    recordDecision(role, workState, result, profile) {
      const selectedFontId = result.selectedStyle?.fontId;
      if (
        !selectedFontId ||
        result.decision.mode !== "apply" ||
        result.decision.resolvedBy === "block_user_lock" ||
        result.decision.resolvedBy === "work_role_user_lock"
      ) {
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
      cacheVisualClusterSelection(
        fontByVisualCluster,
        role,
        workState,
        result,
        selectedFontId,
        palette.reuseVisualClusterFont,
      );
    },
  };
}

/** Resolve body anchors before page-local accent palettes, preserving source order. */
export function orderAutomaticFontMatchingPageItemIndexes(
  items: readonly OverlayItem[],
): number[] {
  return items
    .map((item, index) => ({ index, priority: resolvePageItemPriority(item) }))
    .sort((left, right) =>
      left.priority === right.priority
        ? left.index - right.index
        : left.priority - right.priority,
    )
    .map(({ index }) => index);
}

function resolvePageItemPriority(item: OverlayItem): number {
  const role = resolveItemRole(item);
  if (BODY_ANCHOR_ROLES.has(role)) return 0;
  if (ACCENT_PAGE_ROLES.has(role)) return 1;
  return 2;
}

function resolveItemRole(item: OverlayItem): FontMatchingSemanticRole {
  const role = String(item.fontRole ?? "").trim();
  return (FONT_MATCHING_SEMANTIC_ROLES as readonly string[]).includes(role)
    ? (role as FontMatchingSemanticRole)
    : "unknown_needs_review";
}

function resolveVisualClusterId(
  item: OverlayItem,
  role: FontMatchingSemanticRole,
): string | null {
  if (BODY_ANCHOR_ROLES.has(role)) return null;
  const explicit = readExplicitVisualClusterId(item);
  if (explicit) return explicit;
  if (!DERIVED_VISUAL_CLUSTER_ROLES.has(role)) return null;
  const normalizedSourceText = normalizeSourceTextForVisualCluster(item);
  return normalizedSourceText
    ? `page-auto-${role}-${stableTextHash(normalizedSourceText)}`
    : null;
}

function readExplicitVisualClusterId(item: OverlayItem): string | null {
  return normalizeVisualClusterId(item.visualClusterId) ?? null;
}

function normalizeSourceTextForVisualCluster(item: OverlayItem): string {
  const sourceText = String(item.sourceText ?? "").trim() || item.jp || "";
  return String(sourceText)
    .normalize("NFKC")
    .toLocaleLowerCase("ja")
    .replace(/[\p{White_Space}\p{Punctuation}]+/gu, "");
}

function isIntentionalOverrideSelection(
  result: FontMatchingDecisionResultV2,
): boolean {
  return result.audit.priorityTrace.some(
    (entry) =>
      entry.priority === "work_profile" &&
      entry.status === "selected" &&
      entry.reasonCodes.includes("intentional_override_margin_passed"),
  );
}

function cacheVisualClusterSelection(
  fontByVisualCluster: Map<string, string>,
  role: FontMatchingSemanticRole,
  workState: FontMatchingWorkStateV2 | undefined,
  result: FontMatchingDecisionResultV2,
  selectedFontId: string,
  reuseVisualClusterFont: boolean,
): void {
  const visualClusterId = workState?.visualClusterId;
  // An intentional override already carries its own block/cluster scope.
  // Caching it as the cluster baseline would broaden a block-scoped override
  // to unrelated members of the cluster.
  if (
    !visualClusterId ||
    !reuseVisualClusterFont ||
    isIntentionalOverrideSelection(result)
  ) {
    return;
  }
  fontByVisualCluster.set(
    clusterStateKey(role, visualClusterId),
    selectedFontId,
  );
}

function stableTextHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, "0")}-${[...value].length}`;
}

function clusterStateKey(
  role: FontMatchingSemanticRole,
  visualClusterId: string,
): string {
  return `${role}\u0000${visualClusterId}`;
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
