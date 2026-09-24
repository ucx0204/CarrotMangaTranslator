import { prepareSoundEffectCommand } from "./mcpSoundEffectCommands";
import { captureSoundEffectPage } from "../../shared/soundEffectPageSnapshot";
import type { AppPaths } from "../appPaths";
import type { SoundEffectPreparation } from "../application/mcpSoundEffectPolicy";
import { readWorkContextForEdit } from "../library";
import { assertContextTarget } from "../application/mcpContextEditPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  captureMcpImageFiles,
  verifyMcpImageFiles,
  readMcpImageEditPage,
} from "./mcpImageEditEvidence";
import {
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
    let result: Awaited<ReturnType<typeof prepareSoundEffectCommand>>;
    try {
      result = await prepareSoundEffectCommand(
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
      failedItems: generationFailures(exclusions),
    };
  };
}

function generationFailures(items: ReturnType<typeof soundEffectChanges>) {
  const protectedReasons = new Set([
    "image_generation_blocked",
    "approved_text_required",
    "existing_image_requires_explicit_replacement",
  ]);
  return items.filter(
    (item) => !protectedReasons.has(item.excludedReason ?? ""),
  ).length;
}
