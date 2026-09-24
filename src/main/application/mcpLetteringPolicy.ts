import { hashStableValue } from "../../shared/blockFingerprint";
import {
  McpLetteringPrepareSchema,
  projectMcpLetteringState,
  type McpLetteringPrepare,
  type McpLetteringCommand,
  type McpLetteringChangeView,
} from "../../shared/mcpLettering";
import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import type { BatchPolicy, BatchPlan, BatchPage } from "./mcpPageBatchTypes";
import type { McpContextSnapshot } from "./mcpContextEditPolicy";
import {
  mcpBatchMembership,
  validateBatchTargets,
  requireBatchPage,
} from "./mcpPageBatchPolicy";
import {
  assertMcpLetteringOnly,
  preserveMcpManualSize,
} from "./mcpLetteringProjection";
import { McpEditError } from "./mcpEditPolicy";

export type LetteringBinding = {
  catalogSnapshot: string | null;
  images: { pageId: string; sourceHash: string; cleanedHash: string | null }[];
};
type Change = McpLetteringChangeView & {
  beforeBlock: TranslationBlock | null;
  afterBlock: TranslationBlock | null;
};
type Plan = BatchPlan<Change> & { binding: LetteringBinding };
export type LetteringSnapshotRequest = {
  chapterId: string;
  pageId: string;
  revision: string;
  direction: "apply" | "undo" | "redo";
  command: McpLetteringCommand;
  binding: LetteringBinding;
  dependencies: { pageId: string; revision: string }[];
  blocks: TranslationBlock[];
};
export type LetteringPreparation = (
  saved: McpContextSnapshot,
  input: McpLetteringPrepare,
  access: { owner: string; guard: () => void; signal?: AbortSignal },
) => Promise<{
  pages: MangaPage[];
  binding: LetteringBinding;
  exclusions: Record<string, Record<string, string>>;
}>;

export function createMcpLetteringPolicy(
  prepare: LetteringPreparation,
): BatchPolicy<
  McpLetteringPrepare,
  Change,
  LetteringSnapshotRequest,
  McpLetteringChangeView,
  Plan
> {
  return {
    parse: (value) => McpLetteringPrepareSchema.parse(value),
    plan: async (saved, input, access) => {
      validateBatchTargets(saved, input);
      const result = await prepare(saved, input, access);
      access.guard();
      const pages = input.pages.map((target) => {
        const before = requireBatchPage(saved.chapter, target);
        const after = result.pages.find((page) => page.id === target.pageId);
        if (
          !after ||
          after.blocks.length !== before.blocks.length ||
          after.blocks.some((block, i) => block.id !== before.blocks[i].id)
        )
          throw new McpEditError(
            "invalid_edit",
            "Lettering must retain the full block inventory and order.",
          );
        const selected = new Set(target.edits.map((edit) => edit.blockId));
        for (const [i, block] of before.blocks.entries())
          if (
            !selected.has(block.id) &&
            hashStableValue(block) !== hashStableValue(after.blocks[i])
          )
            throw new McpEditError(
              "invalid_edit",
              "Lettering changed an unselected block.",
            );
        const changes = target.edits.map((edit) =>
          planChange(
            before,
            after,
            edit,
            input,
            result.exclusions[target.pageId]?.[edit.blockId] ?? null,
          ),
        );
        return plannedPage(target, changes);
      });
      pages.sort(
        (a, b) =>
          saved.chapter.pages.findIndex((page) => page.id === a.pageId) -
          saved.chapter.pages.findIndex((page) => page.id === b.pageId),
      );
      return {
        pages,
        workId: saved.workId,
        membership: mcpBatchMembership(saved.chapter),
        binding: result.binding,
      };
    },
    request: createSnapshotRequest,
    project: ({ beforeBlock: _before, afterBlock: _after, ...view }) =>
      structuredClone(view),
    inspectTool: "carrot_get_lettering_batch",
    exclusionWarning: "inspect_lettering_exclusions",
  };
}
function plannedPage(
  target: McpLetteringPrepare["pages"][number],
  changes: Change[],
): BatchPage<Change> {
  const changedBlocks = changes.filter((change) => change.changed).length;
  return {
    pageId: target.pageId,
    expectedRevision: target.revision,
    changes,
    changedBlocks,
    state: changedBlocks
      ? "pending"
      : changes.every((change) => change.excludedReason)
        ? "excluded"
        : "unchanged",
    result: "not_started",
    errorCode: null,
  };
}
function planChange(
  beforePage: MangaPage,
  afterPage: MangaPage,
  edit: McpLetteringPrepare["pages"][number]["edits"][number],
  input: McpLetteringPrepare,
  exclusion: string | null,
): Change {
  const before = beforePage.blocks.find((block) => block.id === edit.blockId);
  const after = afterPage.blocks.find((block) => block.id === edit.blockId);
  if (!before || !after)
    throw new McpEditError("not_found", "Selected lettering block is missing.");
  const excludedReason = before.generatedLettering
    ? "generated_lettering"
    : exclusion;
  // Layout cannot change size in the first place; scalar/inline style requests protect manual size.
  const next = excludedReason
    ? before
    : input.command.kind === "layout"
      ? after
      : preserveMcpManualSize(before, after, input.preserveManualFontSize);
  if (!excludedReason) assertMcpLetteringOnly(before, next, input.command);
  const changed =
    !excludedReason && hashStableValue(before) !== hashStableValue(next);
  return {
    pageId: beforePage.id,
    blockId: before.id,
    reason: edit.reason,
    before: projectMcpLetteringState(before),
    after: projectMcpLetteringState(next),
    changed,
    excludedReason,
    warnings: [
      "rendering_not_performed",
      "layout_shape_is_summarized",
      ...(input.preserveManualFontSize && before.fontSizeIntent === "manual"
        ? ["manual_font_size_preserved"]
        : []),
    ],
    beforeBlock: changed ? structuredClone(before) : null,
    afterBlock: changed ? structuredClone(next) : null,
  };
}
export function applyMcpLetteringSnapshots(
  page: MangaPage,
  request: LetteringSnapshotRequest,
) {
  const next = new Map(request.blocks.map((block) => [block.id, block]));
  if (!next.size || next.size !== request.blocks.length)
    throw new McpEditError(
      "invalid_edit",
      "Distinct lettering snapshots required.",
    );
  for (const [id, block] of next) {
    const current = page.blocks.find((entry) => entry.id === id);
    if (!current)
      throw new McpEditError("not_found", "Lettering block no longer exists.");
    assertMcpLetteringOnly(current, block, request.command);
  }
  return page.blocks.map((block) =>
    structuredClone(next.get(block.id) ?? block),
  );
}

function createSnapshotRequest(
  page: BatchPage<Change>,
  input: McpLetteringPrepare,
  direction: LetteringSnapshotRequest["direction"],
  plan: Plan,
): LetteringSnapshotRequest {
  return {
    chapterId: input.chapterId,
    pageId: page.pageId,
    revision: page.expectedRevision,
    direction,
    command: input.command,
    binding: plan.binding,
    dependencies: plan.pages.map(({ pageId, expectedRevision }) => ({
      pageId,
      revision: expectedRevision,
    })),
    blocks: page.changes
      .filter((change) => change.changed)
      .map((change) => {
        const snapshot =
          direction === "undo" ? change.beforeBlock : change.afterBlock;
        if (!snapshot)
          throw new McpEditError(
            "invalid_edit",
            "Excluded lettering has no write snapshot.",
          );
        return structuredClone(snapshot);
      }),
  };
}
