import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import type { McpSelectionEdit } from "../../shared/mcpSelectionEditing";
import { hashStableValue } from "../../shared/blockFingerprint";
import { resolvePageBlockOrder } from "../../shared/blockReadingOrder";
import type { SelectionSnapshotRequest } from "./mcpSelectionEditPolicy";
import { McpEditError } from "./mcpEditPolicy";

/** Internal computed snapshots only, never caller-supplied blocks or raw page replacement. */
export function applyMcpSelectionSnapshots(
  page: MangaPage,
  request: SelectionSnapshotRequest,
) {
  const ids = new Set(request.changes.map((change) => change.blockId));
  if (!ids.size || ids.size !== request.changes.length || ids.size > 100)
    throw new McpEditError(
      "invalid_edit",
      "Distinct selection snapshots are required.",
    );
  if (
    hashStableValue(page.blockOrder ?? null) !==
    hashStableValue(request.expectedOrder ?? null)
  )
    throw new McpEditError(
      "revision_conflict",
      "Reading order changed after the selection plan.",
    );
  const blocks = structuredClone(page.blocks);
  for (const change of request.changes)
    applyChange(blocks, change, request.direction);
  if (blocks.length > 5000)
    throw new McpEditError(
      "invalid_edit",
      "The native page block limit would be exceeded.",
    );
  const blockOrder = structuredClone(request.blockOrder);
  assertOrder(page, blocks, blockOrder, request);
  return { blocks, blockOrder };
}

function applyChange(
  blocks: TranslationBlock[],
  change: SelectionSnapshotRequest["changes"][number],
  direction: SelectionSnapshotRequest["direction"],
) {
  if (!change.changed || change.excludedReason)
    throw new McpEditError(
      "invalid_edit",
      "Excluded or unchanged selection cannot be committed.",
    );
  const before = direction === "undo" ? change.afterBlock : change.beforeBlock;
  const after = direction === "undo" ? change.beforeBlock : change.afterBlock;
  const matches = blocks.filter((block) => block.id === change.blockId);
  if (
    matches.length !== (before ? 1 : 0) ||
    hashStableValue(matches[0] ?? null) !== hashStableValue(before)
  )
    throw new McpEditError(
      "revision_conflict",
      "A selected block changed; old content will not overwrite it.",
    );
  if (change.requested.kind !== "append") {
    if (!before || !after || before.generatedLettering)
      throw new McpEditError(
        "invalid_edit",
        "An editable existing block is required.",
      );
    assertOnlyRequestedFields(before, after, change.requested);
  } else if (!change.afterBlock || change.beforeBlock !== null) {
    throw new McpEditError(
      "invalid_edit",
      "Append history must describe only one newly created block.",
    );
  }
  if (after && after.id !== change.blockId)
    throw new McpEditError(
      "invalid_edit",
      "Selection snapshots cannot change block identity.",
    );
  const index = blocks.findIndex((block) => block.id === change.blockId);
  if (after) {
    if (index < 0) blocks.push(structuredClone(after));
    else blocks[index] = structuredClone(after);
  } else blocks.splice(index, 1);
}
function assertOnlyRequestedFields(
  before: TranslationBlock,
  after: TranslationBlock,
  edit: McpSelectionEdit,
) {
  const allowed = new Set<string>();
  if (edit.kind === "source") allowed.add("sourceText");
  if (edit.kind === "translation") allowed.add("translatedText");
  if (edit.kind === "references") {
    if (edit.speakerId !== undefined) allowed.add("speakerId");
    if (edit.glossaryEntryIds !== undefined) allowed.add("glossaryEntryIds");
  }
  const protectedFields = (block: TranslationBlock) =>
    Object.fromEntries(
      Object.entries(block).filter(([key]) => !allowed.has(key)),
    );
  if (
    hashStableValue(protectedFields(before)) !==
    hashStableValue(protectedFields(after))
  )
    throw new McpEditError(
      "invalid_edit",
      "Selection editing cannot change unrelated fields, geometry or images.",
    );
}
function assertOrder(
  page: MangaPage,
  blocks: TranslationBlock[],
  blockOrder: string[] | undefined,
  request: SelectionSnapshotRequest,
) {
  const appended = new Set(
    request.changes
      .filter((change) => change.requested.kind === "append")
      .map((change) => change.blockId),
  );
  if (
    !appended.size &&
    hashStableValue(page.blockOrder ?? null) !==
      hashStableValue(blockOrder ?? null)
  )
    throw new McpEditError(
      "invalid_edit",
      "Text and reference edits cannot reorder blocks.",
    );
  const prior = resolvePageBlockOrder(page).filter((id) => !appended.has(id));
  const next = resolvePageBlockOrder({ ...page, blocks, blockOrder }).filter(
    (id) => !appended.has(id),
  );
  if (hashStableValue(prior) !== hashStableValue(next))
    throw new McpEditError(
      "invalid_edit",
      "Append or undo cannot reorder unrelated blocks.",
    );
  if (
    blockOrder &&
    (new Set(blockOrder).size !== blockOrder.length ||
      blockOrder.length !== blocks.length ||
      blocks.some((block) => !blockOrder.includes(block.id)))
  )
    throw new McpEditError(
      "invalid_edit",
      "Stored order must include each remaining block exactly once.",
    );
}
