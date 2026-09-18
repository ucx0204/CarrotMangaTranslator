import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import type { BlockFormatDefaults } from "../../shared/blockFormat";
import { hashStableValue } from "../../shared/blockFingerprint";
import { resolvePageBlockOrder } from "../../shared/blockReadingOrder";
import {
  McpSelectionBatchPreviewSchema,
  type McpSelectionBatchPreview,
  type McpSelectionChangeView,
  type McpSelectionEdit,
} from "../../shared/mcpSelectionEditing";
import type { McpSelectionAnalysisItem } from "../../shared/mcpSelectionAnalysis";
import { assertContextTarget, type McpContextSnapshot } from "./mcpContextEditPolicy";
import {
  assertMcpSelectionFreshness,
  type McpSelectionBinding,
} from "./mcpSelectionAnalysisService";
import { mcpBatchMembership, requireBatchPage, validateBatchTargets } from "./mcpPageBatchPolicy";
import type { BatchPlan, BatchPage, BatchPolicy } from "./mcpPageBatchTypes";
import { projectMcpSelectionEdit, type SelectionProjection } from "./mcpSelectionEditProjection";
import { McpEditError } from "./mcpEditPolicy";

type Evidence = {
  binding: McpSelectionBinding;
  expiresAt: number;
  kind: "ocr" | "translation";
  items: McpSelectionAnalysisItem[];
};
export type SelectionPlanningPorts = {
  prepare: (saved: McpContextSnapshot, input: McpSelectionBatchPreview,
    access: { owner: string; guard: () => void }) => Promise<{
      evidence: Evidence | null; defaults?: BlockFormatDefaults;
    }>;
};
type SelectionChange = McpSelectionChangeView & {
  beforeBlock: TranslationBlock | null;
  afterBlock: TranslationBlock | null;
};
type PageOrder = { pageId: string; before: string[] | undefined; after: string[] | undefined };
type SelectionPlan = BatchPlan<SelectionChange> & {
  binding: McpSelectionBinding;
  evidenceExpiresAt: number | null;
  orders: PageOrder[];
};
export type SelectionSnapshotRequest = {
  chapterId: string;
  pageId: string;
  revision: string;
  direction: "apply" | "undo" | "redo";
  changes: SelectionChange[];
  expectedOrder: string[] | undefined;
  blockOrder: string[] | undefined;
  binding: McpSelectionBinding;
  evidenceExpiresAt: number | null;
};

export function createMcpSelectionEditPolicy(ports: SelectionPlanningPorts, now = Date.now):
  BatchPolicy<McpSelectionBatchPreview, SelectionChange, SelectionSnapshotRequest,
    McpSelectionChangeView, SelectionPlan> {
  return {
    parse: (value) => McpSelectionBatchPreviewSchema.parse(value),
    plan: async (saved, input, access) => {
      validateInput(saved, input);
      const prepared = await ports.prepare(saved, input, access);
      access.guard();
      const evidence = prepared.evidence;
      if (input.command.kind === "analysis" && !evidence)
        throw new McpEditError("not_found", "Completed owned analysis is required.");
      if (evidence) {
        if (evidence.expiresAt <= now())
          throw new McpEditError("not_found", "Selection evidence expired before preview.");
        assertMcpSelectionFreshness(saved, evidence.binding);
      }
      const orders: PageOrder[] = [];
      const pages = input.pages.map((target) => {
        const page = requireBatchPage(saved.chapter, { ...target, edits: [] });
        const changes = target.edits.map((edit) => planChange(saved, page, input, edit, prepared));
        if (new Set(changes.map((change) => change.blockId)).size !== changes.length)
          throw new McpEditError("invalid_edit", "Change each block or discovery at most once per page.");
        orders.push(planOrder(page, changes));
        return describePage(target, changes);
      });
      pages.sort((a, b) => saved.chapter.pages.findIndex((p) => p.id === a.pageId) -
        saved.chapter.pages.findIndex((p) => p.id === b.pageId));
      return {
        workId: saved.workId, membership: mcpBatchMembership(saved.chapter), pages, orders,
        evidenceExpiresAt: evidence?.expiresAt ?? null,
        binding: structuredClone(evidence?.binding ?? {
          chapterId: input.chapterId, contextRevision: input.contextRevision,
          membership: mcpBatchMembership(saved.chapter),
          pages: input.pages.map(({ pageId, revision }) => ({ pageId, revision })),
        }),
      };
    },
    request: (page, input, direction, plan) => {
      const order = plan.orders.find((entry) => entry.pageId === page.pageId);
      if (!order) throw new McpEditError("invalid_edit", "Planned reading order is missing.");
      return {
        chapterId: input.chapterId, pageId: page.pageId, revision: page.expectedRevision,
        direction, changes: structuredClone(page.changes.filter((change) => change.changed)),
        expectedOrder: structuredClone(direction === "undo" ? order.after : order.before),
        blockOrder: structuredClone(direction === "undo" ? order.before : order.after),
        evidenceExpiresAt: plan.evidenceExpiresAt,
        binding: { ...plan.binding, pages: plan.binding.pages.map((dependency) => ({
          ...dependency,
          revision: plan.pages.find((target) => target.pageId === dependency.pageId)?.expectedRevision ?? dependency.revision,
        })) },
      };
    },
    project: ({ beforeBlock: _before, afterBlock: _after, ...view }) => structuredClone(view),
    inspectTool: "carrot_get_selection_batch",
    exclusionWarning: "inspect_selection_exclusions_and_overlap_evidence",
  };
}

function validateInput(saved: McpContextSnapshot, input: McpSelectionBatchPreview) {
  assertContextTarget(saved, input.chapterId, input.contextRevision);
  validateBatchTargets(saved, { ...input, pages: input.pages.map((page) => ({ ...page, edits: [] })) });
  if (input.pages.reduce((count, page) => count + page.edits.length, 0) > 100)
    throw new McpEditError("invalid_edit", "At most 100 selected changes are allowed.");
  for (const page of input.pages) {
    if (page.edits.some((edit) => (edit.kind === "references") !== (input.command.kind === "references")))
      throw new McpEditError("invalid_edit", "Analysis application and reference editing are separate commands.");
  }
}
function planChange(
  saved: McpContextSnapshot, page: MangaPage, input: McpSelectionBatchPreview,
  edit: McpSelectionEdit, prepared: Awaited<ReturnType<SelectionPlanningPorts["prepare"]>>,
): SelectionChange {
  const item = "itemId" in edit ? prepared.evidence?.items.find((entry) => entry.itemId === edit.itemId) : undefined;
  if (edit.kind !== "references") {
    if (!item) throw new McpEditError("not_found", "Selected item is absent from owned analysis.");
    const expected = edit.kind === "translation" ? "translation" : "ocr";
    if (prepared.evidence?.kind !== expected)
      throw new McpEditError("invalid_edit", "Analysis kind does not match the requested edit.");
  }
  const projected = projectMcpSelectionEdit({ saved, page, edit, item,
    requestId: input.requestId, defaults: prepared.defaults });
  const changed = !projected.excludedReason && hashStableValue(projected.before) !== hashStableValue(projected.after);
  return {
    pageId: page.id, blockId: projected.blockId, reason: edit.reason, requested: edit,
    before: textState(projected.before),
    after: textState(projected.excludedReason ? projected.before : projected.after),
    sourceRect: projected.sourceRect, overlapBlockIds: projected.overlapBlockIds,
    excludedReason: projected.excludedReason, changed,
    warnings: ["no_implicit_models_or_rendering", "verify_rendering_after_application",
      ...(edit.kind === "source" ? ["retained_source_measurements_require_review"] : [])],
    beforeBlock: changed ? projected.before : null,
    afterBlock: changed ? projected.after : null,
  };
}
function textState(block: SelectionProjection["before"]) {
  if (!block) return null;
  return {
    sourceText: block.sourceText, translatedText: block.translatedText,
    ...(block.speakerId === undefined ? {} : { speakerId: block.speakerId }),
    ...(block.glossaryEntryIds === undefined ? {} : { glossaryEntryIds: [...block.glossaryEntryIds] }),
  };
}
function planOrder(page: MangaPage, changes: SelectionChange[]): PageOrder {
  const appends = changes.filter((change) => change.changed && change.requested.kind === "append");
  const before = structuredClone(page.blockOrder);
  if (!appends.length) return { pageId: page.id, before, after: before };
  if (page.blocks.length + appends.length > 5000)
    throw new McpEditError("invalid_edit", "The native page block limit would be exceeded.");
  const after = resolvePageBlockOrder(page);
  const anchors = new Map<string | null, string>();
  for (const change of appends) {
    if (change.requested.kind !== "append") continue;
    const anchor = change.requested.afterBlockId;
    if (anchor === undefined) { after.push(change.blockId); continue; }
    if (anchor !== null && !page.blocks.some((block) => block.id === anchor))
      throw new McpEditError("not_found", "Insertion anchor must be an existing block on this page.");
    const resolved = anchors.get(anchor) ?? anchor;
    after.splice(resolved === null ? 0 : after.indexOf(resolved) + 1, 0, change.blockId);
    anchors.set(anchor, change.blockId);
  }
  return { pageId: page.id, before, after };
}
function describePage(target: { pageId: string; revision: string }, changes: SelectionChange[]): BatchPage<SelectionChange> {
  const changedBlocks = changes.filter((change) => change.changed).length;
  return {
    pageId: target.pageId, expectedRevision: target.revision, changes, changedBlocks,
    state: changedBlocks ? "pending" : changes.every((change) => change.excludedReason) ? "excluded" : "unchanged",
    result: "not_started", errorCode: null,
  };
}
