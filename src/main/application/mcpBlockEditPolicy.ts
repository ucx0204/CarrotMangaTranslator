import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import type { ConditionalBatchWritableField } from "../../shared/conditionalBatchRules";
import { createConditionalBatchPreview } from "../../shared/conditionalBatchEngine";
import { normalizeRenderBboxTo1000 } from "../../shared/geometry";
import { constrainEditableRenderBbox } from "../../shared/editableRenderGeometry";
import {
  MIN_RENDER_BBOX_COORDINATE,
  MAX_RENDER_BBOX_COORDINATE,
  MAX_RENDER_BBOX_SIZE,
} from "../../shared/renderBbox";
import { resolvePageBlockOrder } from "../../shared/blockReadingOrder";
import { hashStableValue } from "../../shared/blockFingerprint";
import type {
  McpBlockPatch,
  McpReadingOrder,
} from "../../shared/mcpBlockEditing";
import { McpEditError } from "./mcpEditPolicy";

/** Reuse the existing condition/action engine; typography flags and font-weight
 * normalization are its authority. Source geometry and image/mask data never change. */
export function applyMcpBlockPatch(
  chapter: ChapterSnapshot,
  page: MangaPage,
  edits: McpBlockPatch["edits"],
) {
  const byId = new Map(edits.map((edit) => [edit.blockId, edit]));
  if (!edits.length || byId.size !== edits.length)
    throw new McpEditError(
      "invalid_edit",
      "Provide distinct existing block IDs.",
    );
  const known = new Set(page.blocks.map((block) => block.id));
  if ([...byId.keys()].some((id) => !known.has(id)))
    throw new McpEditError("not_found", "A selected block no longer exists.");
  const changedBlockIds: string[] = [];
  const warnings: string[] = [];
  const blocks = page.blocks.map((block) => {
    const edit = byId.get(block.id);
    if (!edit) return block;
    let next = applyFields(chapter, page, block, edit.fields);
    if (edit.renderRect) next = applyRenderRect(page, next, edit.renderRect);
    if (hashStableValue(block) === hashStableValue(next)) return block;
    changedBlockIds.push(block.id);
    if (block.generatedLettering)
      warnings.push(
        `Block ${block.id}: generated image lettering was retained. Check the rendered result and editable text fallback.`,
      );
    return next;
  });
  return { blocks, changedBlockIds, warnings };
}
function applyFields(
  chapter: ChapterSnapshot,
  page: MangaPage,
  block: TranslationBlock,
  fields: McpBlockPatch["edits"][number]["fields"],
) {
  const changes = Object.entries(fields ?? {}).map(([field, value]) => ({
    field: field as ConditionalBatchWritableField,
    operation: "set" as const,
    value,
  }));
  if (!changes.length) return block;
  const preview = createConditionalBatchPreview(
    chapter,
    { kind: "selection", pageId: page.id, blockIds: [block.id] },
    {
      name: "MCP explicit block fields",
      description: "",
      match: { mode: "allBlocks", conditions: [], groups: [] },
      actions: [{ id: "fields", type: "setFields", enabled: true, changes }],
    },
  );
  return preview.results[0]?.afterBlock ?? block;
}
function applyRenderRect(
  page: MangaPage,
  block: TranslationBlock,
  rect: NonNullable<McpBlockPatch["edits"][number]["renderRect"]>,
): TranslationBlock {
  const normalized = {
    x: (rect.x / page.width) * 1000,
    y: (rect.y / page.height) * 1000,
    w: (rect.w / page.width) * 1000,
    h: (rect.h / page.height) * 1000,
  };
  if (
    normalized.x < MIN_RENDER_BBOX_COORDINATE ||
    normalized.y < MIN_RENDER_BBOX_COORDINATE ||
    normalized.x > MAX_RENDER_BBOX_COORDINATE ||
    normalized.y > MAX_RENDER_BBOX_COORDINATE ||
    normalized.w > MAX_RENDER_BBOX_SIZE ||
    normalized.h > MAX_RENDER_BBOX_SIZE
  )
    throw new McpEditError(
      "invalid_edit",
      "Render rectangle exceeds the app's supported page-relative bounds.",
    );
  return {
    ...block,
    renderBbox: constrainEditableRenderBbox(
      block,
      normalizeRenderBboxTo1000(rect, page, "pixels"),
    ),
    renderBboxSpace: "normalized_1000",
  };
}
export function applyMcpReadingOrder(
  page: MangaPage,
  request: McpReadingOrder,
) {
  const wanted = new Set(request.blockIds);
  if (
    wanted.size !== request.blockIds.length ||
    wanted.size !== page.blocks.length ||
    page.blocks.some((block) => !wanted.has(block.id))
  )
    throw new McpEditError(
      "invalid_edit",
      "Supply every current block ID exactly once; reading order cannot add or delete blocks.",
    );
  const current = resolvePageBlockOrder(page);
  return {
    blockOrder: [...request.blockIds],
    changed: hashStableValue(current) !== hashStableValue(request.blockIds),
  };
}
