import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  McpFormatBatchPreviewSchema,
  type McpFormatBatchPreview,
  type McpFormatChangeView,
} from "../../shared/mcpFormatBatch";
import {
  projectMcpFormat,
  McpFormatFieldsSchema,
} from "../../shared/mcpFormatEditing";
import type { BatchPlan, BatchPage, BatchPolicy } from "./mcpPageBatchTypes";
import {
  mcpBatchMembership,
  requireBatchPage,
  validateBatchTargets,
} from "./mcpPageBatchPolicy";
import { applyMcpBlockPatch } from "./mcpBlockEditPolicy";
import type { McpContextSnapshot } from "./mcpContextEditPolicy";
import { McpEditError } from "./mcpEditPolicy";

type FormatChange = McpFormatChangeView & {
  beforeBlock: TranslationBlock;
  afterBlock: TranslationBlock;
};
export type FormatSnapshotRequest = {
  chapterId: string;
  pageId: string;
  revision: string;
  blocks: TranslationBlock[];
};
function exclusion(
  block: TranslationBlock,
  edit: McpFormatBatchPreview["pages"][number]["edits"][number],
  preserve: boolean,
) {
  if (block.generatedLettering) return "generated_lettering";
  if (
    preserve &&
    block.fontSizeIntent === "manual" &&
    (edit.fields?.fontSizePx !== undefined ||
      edit.fields?.autoFitText !== undefined)
  )
    return "manual_font_size_preserved";
  return null;
}
function prepareChange(
  chapter: ChapterSnapshot,
  page: MangaPage,
  edit: McpFormatBatchPreview["pages"][number]["edits"][number],
  preserve: boolean,
): FormatChange {
  const block = page.blocks.find((candidate) => candidate.id === edit.blockId);
  if (!block)
    throw new McpEditError(
      "not_found",
      "A selected block is absent from its page.",
    );
  if (block.sourceText.length > 20000 || block.translatedText.length > 20000)
    throw new McpEditError(
      "invalid_edit",
      "Stored text exceeds the review limit.",
    );
  const excludedReason = exclusion(block, edit, preserve);
  const patch = excludedReason
    ? null
    : applyMcpBlockPatch(chapter, page, [edit]);
  const afterBlock =
    patch?.blocks.find((item) => item.id === block.id) ?? block;
  const before = projectMcpFormat(page, block);
  const after = projectMcpFormat(page, afterBlock);
  return {
    pageId: page.id,
    blockId: block.id,
    sourceText: block.sourceText,
    translatedText: block.translatedText,
    reason: edit.reason,
    requested: structuredClone(edit),
    before,
    after,
    excludedReason,
    changed:
      !excludedReason && hashStableValue(block) !== hashStableValue(afterBlock),
    warnings: [
      "verify_rendering_explicitly",
      "inline_typography_retained",
      ...(edit.fields?.fontFamily ? ["font_availability_not_verified"] : []),
      ...(edit.renderRect
        ? ["actual_display_geometry_is_normalized_by_app"]
        : []),
    ],
    beforeBlock: structuredClone(block),
    afterBlock: structuredClone(afterBlock),
  };
}
function planPage(
  chapter: ChapterSnapshot,
  target: McpFormatBatchPreview["pages"][number],
  preserve: boolean,
): BatchPage<FormatChange> {
  const page = requireBatchPage(chapter, target);
  const changes = target.edits.map((edit) =>
    prepareChange(chapter, page, edit, preserve),
  );
  const changedBlocks = changes.filter((item) => item.changed).length;
  return {
    pageId: page.id,
    expectedRevision: target.revision,
    changes,
    changedBlocks,
    state: changedBlocks
      ? "pending"
      : changes.every((item) => item.excludedReason)
        ? "excluded"
        : "unchanged",
    result: "not_started",
    errorCode: null,
  };
}
function planMcpFormatBatch(
  saved: McpContextSnapshot,
  input: McpFormatBatchPreview,
): BatchPlan<FormatChange> {
  const request = McpFormatBatchPreviewSchema.parse(input);
  validateBatchTargets(saved, request);
  const pages = request.pages.map((target) =>
    planPage(saved.chapter, target, request.preserveManualFontSize),
  );
  pages.sort(
    (a, b) =>
      saved.chapter.pages.findIndex((page) => page.id === a.pageId) -
      saved.chapter.pages.findIndex((page) => page.id === b.pageId),
  );
  return {
    workId: saved.workId,
    membership: mcpBatchMembership(saved.chapter),
    pages,
  };
}
/** Only app-calculated snapshots cross this INTERNAL port. No remote whole-block input. */
export function applyMcpFormatSnapshots(
  page: MangaPage,
  request: FormatSnapshotRequest,
) {
  const byId = new Map(request.blocks.map((block) => [block.id, block]));
  if (!byId.size || byId.size !== request.blocks.length)
    throw new McpEditError("invalid_edit", "Distinct format targets required.");
  for (const [id, next] of byId) {
    const current = page.blocks.find((block) => block.id === id);
    if (!current)
      throw new McpEditError("not_found", "Format target is missing.");
    if (
      current.generatedLettering ||
      hashStableValue(protectedContent(current)) !==
        hashStableValue(protectedContent(next))
    )
      throw new McpEditError(
        "revision_conflict",
        "Non-format content cannot be replaced by a format batch.",
      );
  }
  return page.blocks.map((block) =>
    structuredClone(byId.get(block.id) ?? block),
  );
}
function protectedContent(block: TranslationBlock) {
  const allowed = new Set<string>([
    ...Object.keys(McpFormatFieldsSchema.shape),
    "renderBbox",
    "renderBboxSpace",
    "fontSizeIntent",
    "fontWeight",
    "outlineWidthScale",
    "layoutIntent",
    "layoutIntentSuppressed",
  ]);
  return Object.fromEntries(
    Object.entries(block).filter(([key]) => !allowed.has(key)),
  );
}
export const formatBatchPolicy: BatchPolicy<
  McpFormatBatchPreview,
  FormatChange,
  FormatSnapshotRequest,
  McpFormatChangeView
> = {
  parse: (value) => McpFormatBatchPreviewSchema.parse(value),
  plan: planMcpFormatBatch,
  request: (page, input, direction) => ({
    chapterId: input.chapterId,
    pageId: page.pageId,
    revision: page.expectedRevision,
    blocks: page.changes
      .filter((change) => change.changed)
      .map((change) =>
        structuredClone(
          direction === "undo" ? change.beforeBlock : change.afterBlock,
        ),
      ),
  }),
  project: ({ beforeBlock: _before, afterBlock: _after, ...view }) =>
    structuredClone(view),
  inspectTool: "carrot_get_format_batch",
  exclusionWarning: "inspect_format_exclusion_reasons",
};
