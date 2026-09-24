import { resolveManualUserLocks } from "../pipeline/automaticFontMatchingV2RuntimeGate";
import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import type { McpTypographyAnalysisObservation } from "../../shared/mcpTypographyAnalysis";
import type { McpTypographyBatchPreview } from "../../shared/mcpTypographyBatch";
import { resolveAutomaticFontDecisionV2 } from "../pipeline/automaticFontMatchingV2";
import { applyAutomaticFontDecisionV2 } from "../pipeline/automaticFontMatchingV2Apply";
import { createAutomaticFontChapterCoordinatorV2 } from "../pipeline/automaticFontMatchingV2PageCoordinator";
import { applySizeOptions } from "../pipeline/overlayFontSize";
import { mcpSourceTypographyItem } from "./mcpSourceTypographyItem";
import type { readMcpTypographyFontEnvironment } from "./mcpTypographyFontRuntime";

type Environment = Awaited<ReturnType<typeof readMcpTypographyFontEnvironment>>;
type Identity = { workId: string; chapterId: string };
type Evidence =
  McpTypographyAnalysisObservation["pages"][number]["items"][number];
type Selection = McpTypographyBatchPreview["pages"][number]["edits"][number];
/** Canonical appliers only. Absent C23 evidence must never activate a fallback font. */
export function projectMcpTypographyApplication(
  page: MangaPage,
  block: TranslationBlock,
  evidence: Evidence,
  selection: Selection,
  preserveManualFontSize: boolean,
  identity: Identity,
  environment: Environment,
) {
  const reason = block.generatedLettering
    ? "generated_lettering"
    : block.textRole === "sound"
      ? "sound_effect_block"
      : null;
  if (reason)
    return {
      block: structuredClone(block),
      fontExclusion: reason,
      sizeExclusion: reason,
    };
  const font = projectFont(
    page,
    block,
    evidence,
    selection.mode,
    identity,
    environment,
  );
  const size = projectSize(
    font.block,
    evidence,
    selection.mode,
    preserveManualFontSize,
  );
  return {
    block: size.block,
    fontExclusion: font.exclusion,
    sizeExclusion: size.exclusion,
  };
}

function projectFont(
  page: MangaPage,
  block: TranslationBlock,
  evidence: Evidence,
  mode: Selection["mode"],
  identity: Identity,
  environment: Environment,
) {
  const current = structuredClone(block);
  if (mode === "size") return { block: current, exclusion: "not_requested" };
  if (!evidence.font || evidence.fontExclusion)
    return {
      block: current,
      exclusion: evidence.fontExclusion ?? "no_font_evidence",
    };
  const decision = resolveObservedFont(
    page,
    block,
    evidence,
    identity,
    environment,
  );
  return decision?.sourceChapterStyle
    ? {
        block: applyAutomaticFontDecisionV2(current, decision),
        exclusion: null,
      }
    : {
        block: current,
        exclusion: "manual_font_lock_or_unavailable_c23_choice",
      };
}

function projectSize(
  block: TranslationBlock,
  evidence: Evidence,
  mode: Selection["mode"],
  preserve: boolean,
) {
  if (mode === "font") return { block, exclusion: "not_requested" };
  if (!evidence.estimate || evidence.sizeExclusion)
    return { block, exclusion: evidence.sizeExclusion ?? "no_size_evidence" };
  if (preserve && block.fontSizeIntent === "manual")
    return { block, exclusion: "manual_font_size_preserved" };
  return {
    block: applySizeOptions(block, undefined, {
      aiFontSizeMatching: true,
      sourceFontSize: evidence.estimate,
    }),
    exclusion: null,
  };
}

function resolveObservedFont(
  page: MangaPage,
  block: TranslationBlock,
  evidence: Evidence,
  identity: Identity,
  environment: Environment,
) {
  // A saved semantic role never routes automatic selection; it can only veto
  // replacing an explicitly user-locked role. The canonical pixel-only resolver
  // still decides the candidate and separately checks the runtime's role locks.
  const locks = resolveManualUserLocks(
    environment.profile,
    identity.workId,
    identity.chapterId,
    page.id,
    block.id,
    block.fontRole ?? "unknown_needs_review",
  );
  if (locks.block || locks.role) return undefined;
  const decision = resolveAutomaticFontDecisionV2({
    page,
    block,
    item: {
      ...mcpSourceTypographyItem(page, block, 0),
      fontRoleConfidence: block.fontRoleConfidence,
    },
    options: {
      enabled: true,
      targetLanguage: "ko",
      ...identity,
      profile: environment.profile,
      candidates: environment.candidates,
      pageCoordinator: {
        ...createAutomaticFontChapterCoordinatorV2(),
        sourceStyleFor: () => evidence.font ?? undefined,
      },
    },
  });
  return decision;
}
