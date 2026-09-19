import { hashStableValue } from "../../shared/blockFingerprint";
import { captureSoundEffectPage } from "../../shared/soundEffectPageSnapshot";
import type { AppPaths } from "../appPaths";
import type { SoundEffectPreparation } from "../application/mcpSoundEffectPolicy";
import { editSoundEffectBlocks } from "../application/mcpSoundEffectBlocks";
import { readWorkContextForEdit } from "../library";
import { assertContextTarget } from "../application/mcpContextEditPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import { resolveCompletionAfterBlockMutation } from "../libraryStore/translationCompletionInvalidation";
import {
  captureMcpImageFiles,
  verifyMcpImageFiles,
  readMcpImageEditPage,
} from "./mcpImageEditEvidence";
import {
  projectSoundEffectReview,
  materializeSoundEffects,
} from "./mcpSoundEffectEdits";
import { readMcpSoundEffectSettings } from "./mcpSoundEffectSettings";
import {
  generateMcpSoundEffects,
  SoundEffectCleanupError,
  type SoundEffectGenerationRuntime,
} from "./mcpSoundEffectGeneration";
import { soundEffectChanges } from "./mcpSoundEffectState";
import { createSoundEffectReviewPageRevision } from "../../shared/pageRevision";

export function createMcpSoundEffectPreparation(
  paths: AppPaths,
  runtime?: SoundEffectGenerationRuntime,
): SoundEffectPreparation {
  let generationFault: SoundEffectCleanupError | undefined;
  return async (page, input, access) => {
    if (input.command.kind === "generate" && generationFault)
      throw new McpEditError(
        "editor_busy",
        "The previous image client cleanup failed. Reopen this session after resolving the local runtime.",
        { cause: generationFault },
      );
    const before = captureSoundEffectPage(page);
    if (Buffer.byteLength(JSON.stringify([before, before])) > 3 * 1024 * 1024)
      throw new McpEditError(
        "invalid_edit",
        "Page snapshots exceed the bounded sound-effect plan budget; no model was started.",
      );
    const files = await captureMcpImageFiles(page, access.guard);
    const verify = async () => {
      assertContextTarget(
        await readWorkContextForEdit(input.chapterId),
        input.chapterId,
        input.contextRevision,
      );
      await verifyMcpImageFiles(files, access.guard);
      const latest = await readMcpImageEditPage(input, access.guard);
      if (createSoundEffectReviewPageRevision(latest) !== input.reviewRevision)
        throw new McpEditError(
          "revision_conflict",
          "Sound-effect review changed during preparation.",
        );
      access.guard();
    };
    let result: Awaited<ReturnType<typeof prepareCommand>>;
    try {
      result = await prepareCommand(
        page,
        input,
        access,
        paths,
        verify,
        runtime,
      );
    } catch (error) {
      if (error instanceof SoundEffectCleanupError) generationFault = error;
      throw error;
    }
    const { next, generationCalls, exclusions } = result;
    await verify();
    const after = captureSoundEffectPage(next);
    const changes = [
      ...soundEffectChanges(page, next, input.command.kind),
      ...exclusions,
    ];
    if (!changes.length)
      changes.push({
        pageId: page.id,
        id: page.id,
        action: input.command.kind,
        before: null,
        after: null,
        changed: false,
        excludedReason: "no_change",
        warnings: [],
      });
    return {
      before,
      after,
      files,
      changes,
      generationCalls,
      failedItems: exclusions.length,
    };
  };
}

async function prepareCommand(
  page: Parameters<SoundEffectPreparation>[0],
  input: Parameters<SoundEffectPreparation>[1],
  access: Parameters<SoundEffectPreparation>[2],
  paths: AppPaths,
  verify: () => Promise<void>,
  runtime?: SoundEffectGenerationRuntime,
) {
  let next = page;
  let generationCalls = 0;
  let exclusions: ReturnType<typeof soundEffectChanges> = [];
  switch (input.command.kind) {
    case "review":
      next = projectSoundEffectReview(page, input);
      break;
    case "materialize":
      next = materializeSoundEffects(
        page,
        input,
        (await readMcpSoundEffectSettings(paths)).defaults,
      );
      break;
    case "text":
    case "image-state": {
      next = editSoundEffectBlocks(page, input);
      if (hashStableValue(next.blocks) !== hashStableValue(page.blocks))
        next = {
          ...next,
          translationCompletion: resolveCompletionAfterBlockMutation(
            page.translationCompletion,
            page.blocks,
            next.blocks,
          ),
        };
      break;
    }
    case "generate": {
      const result = await generateMcpSoundEffects({
        page,
        input,
        paths,
        signal: access.signal ?? new AbortController().signal,
        guard: verify,
        runtime,
      });
      next = result.page;
      generationCalls = result.generationCalls;
      exclusions = result.exclusions;
      break;
    }
  }
  return { next, generationCalls, exclusions };
}
