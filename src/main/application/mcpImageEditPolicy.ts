import type { MangaPage } from "../../shared/libraryTypes";
import {
  McpImageEditPreviewSchema,
  type McpImageEditPreview,
  type McpImageEditChangeView,
} from "../../shared/mcpImageEditing";
import type { BatchPlan, BatchPolicy } from "./mcpPageBatchTypes";
import {
  mcpBatchMembership,
  requireBatchPage,
  validateBatchTargets,
} from "./mcpPageBatchPolicy";

export type McpImageFileEvidence = { path: string; sha256: string };
type McpImageEditEvidence = {
  files: McpImageFileEvidence[];
  mask: McpImageEditChangeView["mask"];
};
type ImageChange = McpImageEditChangeView & {
  evidence: McpImageEditEvidence;
  recovery: { transactionId?: string; files?: McpImageFileEvidence[] };
};
export type McpImageEditRequest = {
  chapterId: string;
  pageId: string;
  revision: string;
  direction: "apply" | "undo" | "redo";
  change: ImageChange;
};
export type McpImageEditPlanning = {
  prepare: (
    page: MangaPage,
    input: McpImageEditPreview,
    guard: () => void,
  ) => Promise<McpImageEditEvidence>;
};

export function createMcpImageEditPolicy(
  ports: McpImageEditPlanning,
): BatchPolicy<
  McpImageEditPreview,
  ImageChange,
  McpImageEditRequest,
  McpImageEditChangeView,
  BatchPlan<ImageChange>
> {
  return {
    parse: (value) => McpImageEditPreviewSchema.parse(value),
    plan: async (saved, input, access) => {
      const target = {
        pageId: input.pageId,
        revision: input.revision,
        edits: [],
      };
      validateBatchTargets(saved, { ...input, pages: [target] });
      const page = requireBatchPage(saved.chapter, target);
      const evidence = await ports.prepare(page, input, access.guard);
      access.guard();
      const changed = evidence.mask.selectedPixels > 0;
      const change: ImageChange = {
        pageId: page.id,
        command: structuredClone(input.command),
        mask: evidence.mask,
        evidence,
        recovery: {},
        changed,
        excludedReason: changed ? null : "empty_effective_mask",
        outcome: null,
        warnings: [
          "image_edit_only_text_layout_and_original_preserved",
          "mask_white_pixels_only_protection_wins",
          "pixel_change_does_not_prove_text_removed_or_quality",
          "native_session_history_not_durable",
          ...(input.command.kind === "erase-blocks"
            ? ["unselected_source_blocks_protected"]
            : []),
          ...(evidence.mask.droppedPixels
            ? ["native_erasure_components_under_12_pixels_omitted"]
            : []),
        ],
      };
      return {
        workId: saved.workId,
        membership: mcpBatchMembership(saved.chapter),
        pages: [
          {
            pageId: page.id,
            expectedRevision: input.revision,
            changes: [change],
            changedBlocks: changed ? 1 : 0,
            state: changed ? "pending" : "excluded",
            result: "not_started",
            errorCode: null,
          },
        ],
      };
    },
    request: (page, input, direction) => ({
      chapterId: input.chapterId,
      pageId: page.pageId,
      revision: page.expectedRevision,
      direction,
      change: page.changes[0],
    }),
    project: ({ evidence: _evidence, recovery: _recovery, ...view }) =>
      structuredClone(view),
    inspectTool: "carrot_get_image_edit",
    exclusionWarning: "empty_mask_no_model_or_save",
  };
}
