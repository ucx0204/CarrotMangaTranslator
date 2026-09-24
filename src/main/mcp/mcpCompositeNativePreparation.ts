import {
  McpTypographyPreflightInput,
  McpTypographyPreflightOutput,
} from "../../shared/mcpTypographyRead";
import { McpTypographyAnalysisObservationSchema } from "../../shared/mcpTypographyAnalysis";
import { mcpSoundEffectOutputs } from "../../shared/mcpSoundEffects";
import { createSoundEffectReviewPageRevision } from "../../shared/pageRevision";
import type { McpCompositeWorkflowAction } from "../../shared/mcpCompositeWorkflowActions";
import type {
  McpCompositeGuard,
  McpCompositeRecord,
} from "../application/mcpCompositeWorkflowPorts";
import type { McpOperationService } from "../application/mcpOperationService";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpCompositeNativePage } from "./mcpCompositeNativePages";
import type { CompositeNativeRead } from "./mcpCompositeNativeTools";
import {
  nativeCompositeCost,
  requireCompositeWholePages,
  selectCompositeNativePages,
  scopeError,
} from "./mcpCompositeNativeScope";

type Analyze = Extract<
  McpCompositeWorkflowAction,
  { kind: "typography-analyze" }
>;
type Typography = Extract<
  McpCompositeWorkflowAction,
  { kind: "typography-prepare" }
>;
type Lettering = Extract<
  McpCompositeWorkflowAction,
  { kind: "lettering-prepare" }
>;
type SoundEffect = Extract<McpCompositeWorkflowAction, { kind: "sfx-prepare" }>;

export async function costCompositeTypographyAnalysis(
  read: CompositeNativeRead,
  record: McpCompositeRecord,
  action: Analyze,
  values: McpCompositeNativePage[],
  guard: McpCompositeGuard,
) {
  const input = action.input;
  selectCompositeNativePages(values, input.chapterId, input.pages);
  const query = McpTypographyPreflightInput.parse({
    chapterId: input.chapterId,
    pageIds: input.pages.map((page) => page.pageId),
    mode: input.mode,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    allowOcr: input.allowOcr,
    preserveManualFontSize: input.preserveManualFontSize,
  });
  const review = await read(
    McpTypographyPreflightOutput,
    "carrot_preflight_typography",
    query,
    record.owner,
    guard,
  );
  if (
    review.status !== "inputs_available" ||
    review.snapshot !== input.snapshot ||
    review.catalogSnapshot !== input.catalogSnapshot ||
    !review.analysisToolAvailable
  )
    throw scopeError();
  const cost = nativeCompositeCost(input.pages.length);
  if (input.mode !== "size") {
    cost.models.typography = Math.max(1, review.counts.fontEligible);
    cost.models.ocr = Math.max(1, review.counts.fontEligible);
  }
  return cost;
}
export async function costCompositeTypographyPreparation(
  operations: McpOperationService,
  record: McpCompositeRecord,
  action: Typography,
  values: McpCompositeNativePage[],
  guard: McpCompositeGuard,
) {
  const input = action.input;
  selectCompositeNativePages(
    values,
    input.chapterId,
    input.pages.map((page) => ({
      ...page,
      blockIds: page.edits.map((edit) => edit.blockId),
    })),
    input.contextRevision,
  );
  await operations.ready();
  guard();
  const job = operations.status(input.analysisJobId, record.owner);
  const observation = McpTypographyAnalysisObservationSchema.safeParse(
    job.result?.typographyAnalysis,
  );
  if (
    job.kind !== "typographyAnalysis" ||
    job.status !== "completed" ||
    !observation.success ||
    observation.data.expiresAt <= Date.now() ||
    input.pages.some(
      (page) =>
        !observation.data.pages.some(
          (found) =>
            found.pageId === page.pageId && found.revision === page.revision,
        ),
    )
  )
    throw scopeError();
  return nativeCompositeCost(input.pages.length);
}
export function costCompositeLetteringPreparation(
  action: Lettering,
  values: McpCompositeNativePage[],
) {
  const input = action.input;
  const pages = selectCompositeNativePages(
    values,
    input.chapterId,
    input.pages.map((page) => ({
      ...page,
      blockIds: page.edits.map((edit) => edit.blockId),
    })),
    input.contextRevision,
  );
  const cost = nativeCompositeCost(pages.length);
  if (input.command.kind === "layout" && input.command.mode !== "wrap")
    cost.models.typography = pages.length;
  return cost;
}
export async function costCompositeSoundEffectPreparation(
  read: CompositeNativeRead,
  record: McpCompositeRecord,
  action: SoundEffect,
  values: McpCompositeNativePage[],
  guard: McpCompositeGuard,
) {
  const input = action.input;
  const command = input.command;
  const blockIds =
    command.kind === "text"
      ? command.edits.map((edit) => edit.blockId)
      : command.kind === "image-state" || command.kind === "generate"
        ? command.blockIds
        : undefined;
  const pages = selectCompositeNativePages(
    values,
    input.chapterId,
    [
      {
        pageId: input.pageId,
        revision: input.revision,
        ...(blockIds ? { blockIds } : {}),
      },
    ],
    input.contextRevision,
  );
  if (
    createSoundEffectReviewPageRevision(pages[0].page) !== input.reviewRevision
  )
    throw scopeError();
  if (!blockIds) requireCompositeWholePages(pages);
  if (
    command.kind === "review" &&
    command.decisions.length + command.additions.length > 100
  )
    throw scopeError();
  const cost = nativeCompositeCost(1);
  if (command.kind === "generate") {
    const view = await read(
      mcpSoundEffectOutputs.carrot_get_sound_effects,
      "carrot_get_sound_effects",
      {
        chapterId: input.chapterId,
        pageId: input.pageId,
        reviewRevision: input.reviewRevision,
        offset: 0,
        limit: 1,
      },
      record.owner,
      guard,
    );
    if (
      !command.allowExternalProcessing ||
      command.expectedModel !== view.generation.configuredModel
    )
      throw new McpEditError(
        "invalid_edit",
        "Sound-effect generation must use the explicitly approved configured image model.",
      );
    cost.models.soundEffect = command.blockIds.length;
  }
  return cost;
}
