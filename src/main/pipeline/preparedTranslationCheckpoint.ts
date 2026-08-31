import type { TranslationOptions } from "../appSettings";
import type { MangaPage } from "../../shared/libraryTypes";
import { createPageRevision } from "../../shared/pageRevision";
import type { PageRevision } from "../../shared/pageRevisionTypes";
import {
  DEFAULT_SOURCE_LANGUAGE,
  DEFAULT_TARGET_LANGUAGE,
} from "../../shared/translationLanguageDefaults";
import type { PreviousOverlayBlockForPrompt } from "../appSettings";
import type { OverlayItem, PageContextPayload } from "./types";
import type {
  PageBuildResult,
  PreparedPageBuildResult,
} from "./pageResultBuilder";
import {
  PreparedTranslationCheckpointSchema,
  type PreparedTranslationCheckpoint,
} from "./preparedTranslationCheckpointContract";
import {
  TRANSLATION_CHECKPOINT_PIPELINE_CONTRACT,
  TRANSLATION_CHECKPOINT_SCHEMA_VERSION,
} from "../../shared/translationCheckpoint";

export function resolveCheckpointCompatibility({
  checkpoint,
  page,
  sourceLanguage,
  targetLanguage,
  blockMode,
}: {
  checkpoint: PreparedTranslationCheckpoint;
  page: MangaPage;
  sourceLanguage?: string;
  targetLanguage?: string;
  blockMode?: "auto" | "keep";
}): { reusable: true } | { reusable: false; reason: string } {
  if (checkpoint.inputRevision !== createPageRevision(page)) {
    return { reusable: false, reason: "input-revision-mismatch" };
  }
  if (
    checkpoint.sourceLanguage !== (sourceLanguage ?? DEFAULT_SOURCE_LANGUAGE) ||
    checkpoint.targetLanguage !== (targetLanguage ?? DEFAULT_TARGET_LANGUAGE)
  ) {
    return { reusable: false, reason: "language-pair-mismatch" };
  }
  if (checkpoint.blockMode !== (blockMode ?? "auto")) {
    return { reusable: false, reason: "block-mode-mismatch" };
  }
  return { reusable: true };
}

export function buildPreparedTranslationCheckpoint({
  prepared,
  pageId,
  inputRevision,
  sourceLanguage,
  targetLanguage,
  blockMode,
  translationDurationMs,
  savedAt = new Date().toISOString(),
}: {
  prepared: PreparedPageBuildResult;
  pageId: string;
  inputRevision: PageRevision;
  sourceLanguage: string;
  targetLanguage: string;
  blockMode: "auto" | "keep";
  translationDurationMs: number;
  savedAt?: string;
}): PreparedTranslationCheckpoint {
  return PreparedTranslationCheckpointSchema.parse({
    schemaVersion: TRANSLATION_CHECKPOINT_SCHEMA_VERSION,
    pipelineContractVersion: TRANSLATION_CHECKPOINT_PIPELINE_CONTRACT,
    pageId,
    inputRevision,
    sourceLanguage,
    targetLanguage,
    blockMode,
    savedAt,
    translationDurationMs: normalizeDuration(translationDurationMs),
    prepared: serializePrepared(prepared),
  });
}

export function restorePreparedTranslationCheckpoint(
  checkpoint: PreparedTranslationCheckpoint,
  page: MangaPage,
  pageOptions: TranslationOptions,
): PreparedPageBuildResult {
  const prepared = checkpoint.prepared;
  if (prepared.kind === "ready") {
    const result: PageBuildResult =
      prepared.resultKind === "no-text"
        ? {
            kind: "no-text",
            page: restoreReadyPage(page, prepared.blocks, prepared.blockOrder),
            warnings: prepared.warnings,
            pageContext: prepared.pageContext,
          }
        : {
            kind: "completed",
            page: restoreReadyPage(page, prepared.blocks, prepared.blockOrder),
            warnings: prepared.warnings,
            detail: prepared.detail ?? "",
            pageContext: prepared.pageContext,
          };
    return { kind: "ready", result };
  }
  return {
    ...prepared,
    page,
    pageOptions: {
      ...pageOptions,
      previousBlocksForPrompt: prepared.previousBlocks as
        | PreviousOverlayBlockForPrompt[]
        | undefined,
      keepBlocksMode: checkpoint.blockMode === "keep" || undefined,
    },
    items: prepared.items as OverlayItem[],
    fontInferenceItems: prepared.fontInferenceItems as OverlayItem[],
    keepBlocksInferenceBlocks: prepared.keepBlocksInferenceBlocks as
      | { blockId: string; item: OverlayItem }[]
      | undefined,
    pageContext: prepared.pageContext as PageContextPayload | undefined,
  };
}

function serializePrepared(prepared: PreparedPageBuildResult) {
  if (prepared.kind === "ready") {
    return {
      kind: "ready" as const,
      resultKind: prepared.result.kind,
      blocks: prepared.result.page.blocks,
      blockOrder: prepared.result.page.blockOrder,
      warnings: prepared.result.warnings,
      detail:
        prepared.result.kind === "completed"
          ? prepared.result.detail
          : undefined,
      pageContext: prepared.result.pageContext,
    };
  }
  return {
    kind: "translated" as const,
    jobId: prepared.jobId,
    items: prepared.items,
    fontInferenceItems: prepared.fontInferenceItems,
    keepBlocksInferenceBlocks: prepared.keepBlocksInferenceBlocks,
    previousBlocks: prepared.pageOptions.previousBlocksForPrompt,
    soundDroppedCount: prepared.soundDroppedCount,
    validationDroppedCount: prepared.validationDroppedCount,
    validationReasons: prepared.validationReasons,
    omittedCandidateIds: prepared.omittedCandidateIds,
    remappedCount: prepared.remappedCount,
    contextWarnings: prepared.contextWarnings,
    pageContext: prepared.pageContext,
  };
}

function restoreReadyPage(
  page: MangaPage,
  blocks: MangaPage["blocks"],
  blockOrder?: string[],
): MangaPage {
  return {
    ...page,
    blocks,
    blockOrder,
    analysisStatus: "completed",
    lastError: undefined,
  };
}

function normalizeDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
