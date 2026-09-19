import type { SoundEffectPageSnapshot } from "../../shared/soundEffectPageSnapshot";
import type { McpImageFileEvidence } from "./mcpImageEditPolicy";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  McpSoundEffectPrepareSchema,
  type McpSoundEffectPrepare,
  type McpSoundEffectChange,
} from "../../shared/mcpSoundEffects";
import { assertContextTarget } from "./mcpContextEditPolicy";
import {
  validateBatchTargets,
  mcpBatchMembership,
  requireBatchPage,
} from "./mcpPageBatchPolicy";
import type { BatchPlan, BatchPolicy } from "./mcpPageBatchTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import { createSoundEffectReviewPageRevision } from "../../shared/pageRevision";
import { McpEditError } from "./mcpEditPolicy";

export type PreparedSoundEffect = {
  before: SoundEffectPageSnapshot;
  after: SoundEffectPageSnapshot;
  files: McpImageFileEvidence[];
  changes: McpSoundEffectChange[];
  generationCalls: number;
  failedItems: number;
};
export type SoundEffectPlan = BatchPlan<McpSoundEffectChange> &
  PreparedSoundEffect;
export type SoundEffectRequest = {
  chapterId: string;
  pageId: string;
  revision: string;
  direction: "apply" | "undo" | "redo";
  expected: SoundEffectPageSnapshot;
  replacement: SoundEffectPageSnapshot;
  files: McpImageFileEvidence[];
};
export type SoundEffectPreparation = (
  page: MangaPage,
  input: McpSoundEffectPrepare,
  access: { owner: string; guard: () => void; signal?: AbortSignal },
) => Promise<PreparedSoundEffect>;
export function createMcpSoundEffectPolicy(
  prepare: SoundEffectPreparation,
): BatchPolicy<
  McpSoundEffectPrepare,
  McpSoundEffectChange,
  SoundEffectRequest,
  McpSoundEffectChange,
  SoundEffectPlan
> {
  return {
    parse: (value) => McpSoundEffectPrepareSchema.parse(value),
    plan: async (saved, input, access) => {
      assertContextTarget(saved, input.chapterId, input.contextRevision);
      const target = {
        pageId: input.pageId,
        revision: input.revision,
        edits: [],
      };
      validateBatchTargets(saved, { ...input, pages: [target] });
      const page = requireBatchPage(saved.chapter, target);
      if (createSoundEffectReviewPageRevision(page) !== input.reviewRevision)
        throw new McpEditError(
          "revision_conflict",
          "Sound-effect candidates changed. Read the review again.",
        );
      const prepared = await prepare(page, input, access);
      access.guard();
      const changed =
        hashStableValue(prepared.before) !== hashStableValue(prepared.after);
      return {
        ...prepared,
        workId: saved.workId,
        membership: mcpBatchMembership(saved.chapter),
        pages: [
          {
            pageId: input.pageId,
            expectedRevision: input.revision,
            state: changed ? "pending" : "excluded",
            result: "not_started",
            errorCode: null,
            changedBlocks: changedBlockCount(prepared.before, prepared.after),
            changes: prepared.changes,
          },
        ],
      };
    },
    request: (page, input, direction, plan) => ({
      chapterId: input.chapterId,
      pageId: page.pageId,
      revision: page.expectedRevision,
      direction,
      expected: direction === "undo" ? plan.after : plan.before,
      replacement: direction === "undo" ? plan.before : plan.after,
      files: plan.files,
    }),
    project: (change) => structuredClone(change),
    inspectTool: "carrot_get_sound_effect_batch",
    exclusionWarning: "inspect_sound_effect_exclusions_and_generation_failures",
  };
}
function changedBlockCount(
  before: SoundEffectPageSnapshot,
  after: SoundEffectPageSnapshot,
) {
  const left = new Map(
    before.blocks.map((block) => [block.id, hashStableValue(block)]),
  );
  const right = new Map(
    after.blocks.map((block) => [block.id, hashStableValue(block)]),
  );
  const ids = new Set([...left.keys(), ...right.keys()]);
  return [...ids].filter((id) => left.get(id) !== right.get(id)).length;
}
