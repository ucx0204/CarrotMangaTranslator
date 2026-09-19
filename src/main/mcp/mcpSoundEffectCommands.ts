import { hashStableValue } from "../../shared/blockFingerprint";
import type { AppPaths } from "../appPaths";
import type { SoundEffectPreparation } from "../application/mcpSoundEffectPolicy";
import { editSoundEffectBlocks } from "../application/mcpSoundEffectBlocks";
import { resolveCompletionAfterBlockMutation } from "../libraryStore/translationCompletionInvalidation";
import {
  projectSoundEffectReview,
  materializeSoundEffects,
} from "./mcpSoundEffectEdits";
import { readMcpSoundEffectSettings } from "./mcpSoundEffectSettings";
import {
  generateMcpSoundEffects,
  type SoundEffectGenerationRuntime,
} from "./mcpSoundEffectGeneration";
import type { soundEffectChanges } from "./mcpSoundEffectState";

export async function prepareSoundEffectCommand(
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
