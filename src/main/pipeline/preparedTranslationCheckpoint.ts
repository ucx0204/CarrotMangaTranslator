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
import { attachEffectReviewToPage } from "./pageResponseParser";
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

export class PreparedTranslationCheckpointValidationError extends Error {
  readonly failureCategory = "checkpoint-validation";

  constructor(cause: Error) {
    super(`번역 체크포인트 데이터 검증에 실패했습니다: ${cause.message}`, {
      cause,
    });
    this.name = "PreparedTranslationCheckpointValidationError";
  }
}

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
  if (!checkpoint.soundEffectReviewPreserved) {
    return { reusable: false, reason: "sound-effect-review-not-preserved" };
  }
  if (
    checkpoint.blockMode === "keep" &&
    checkpoint.prepared.kind === "translated" &&
    checkpoint.prepared.soundDroppedCount > 0
  ) {
    return { reusable: false, reason: "kept-sound-translations-dropped" };
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
  const result = PreparedTranslationCheckpointSchema.safeParse({
    schemaVersion: TRANSLATION_CHECKPOINT_SCHEMA_VERSION,
    pipelineContractVersion: TRANSLATION_CHECKPOINT_PIPELINE_CONTRACT,
    soundEffectReviewPreserved: true,
    pageId,
    inputRevision,
    sourceLanguage,
    targetLanguage,
    blockMode,
    savedAt,
    translationDurationMs: normalizeDuration(translationDurationMs),
    prepared: serializePrepared(prepared),
  });
  if (!result.success)
    throw new PreparedTranslationCheckpointValidationError(result.error);
  return result.data;
}

export function restorePreparedTranslationCheckpoint(
  checkpoint: PreparedTranslationCheckpoint,
  page: MangaPage,
  pageOptions: TranslationOptions,
): PreparedPageBuildResult {
  const prepared = checkpoint.prepared;
  const preparedPage = prepared.soundEffectReview
    ? attachEffectReviewToPage(page, "hayai", {
        hints: [],
        diagnostics: [],
        effectReviewRegions: prepared.soundEffectReview.regions,
      })
    : page;
  if (prepared.kind === "ready") {
    const result: PageBuildResult =
      prepared.resultKind === "no-text"
        ? {
            kind: "no-text",
            page: restoreReadyPage(
              preparedPage,
              prepared.blocks,
              prepared.blockOrder,
            ),
            warnings: prepared.warnings,
            pageContext: prepared.pageContext,
          }
        : {
            kind: "completed",
            page: restoreReadyPage(
              preparedPage,
              prepared.blocks,
              prepared.blockOrder,
            ),
            warnings: prepared.warnings,
            detail: prepared.detail ?? "",
            pageContext: prepared.pageContext,
          };
    return { kind: "ready", result };
  }
  return {
    ...prepared,
    page: preparedPage,
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
      soundEffectReview: prepared.result.page.soundEffectReview,
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
    soundEffectReview: prepared.page.soundEffectReview,
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
