import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  McpExternalImagePreviewSchema,
  type McpExternalImagePreview,
  type McpExternalImageChangeView,
} from "../../shared/mcpExternalImages";
import type { BatchPolicy, BatchPlan } from "./mcpPageBatchTypes";
import type { McpImageEditRequest } from "./mcpImageEditPolicy";
import {
  mcpBatchMembership,
  requireBatchPage,
  validateBatchTargets,
} from "./mcpPageBatchPolicy";
import { McpEditError } from "./mcpEditPolicy";

type ImageChange = McpImageEditRequest["change"];
export type ExternalImageChange = McpExternalImageChangeView & {
  evidence: ImageChange["evidence"];
  recovery: ImageChange["recovery"];
  outcome: ImageChange["outcome"];
  beforeBlock?: TranslationBlock;
  afterBlock?: TranslationBlock;
};
export type ExternalImageRequest = {
  chapterId: string;
  pageId: string;
  revision: string;
  direction: "apply" | "undo" | "redo";
  owner: string;
  input: McpExternalImagePreview;
  change: ExternalImageChange;
};
export type ExternalImagePlanning = (
  page: MangaPage,
  input: McpExternalImagePreview,
  owner: string,
  guard: () => void,
) => Promise<ExternalImageChange>;
type Plan = BatchPlan<ExternalImageChange> & { owner: string };
export function createMcpExternalImagePolicy(
  prepare: ExternalImagePlanning,
): BatchPolicy<
  McpExternalImagePreview,
  ExternalImageChange,
  ExternalImageRequest,
  McpExternalImageChangeView,
  Plan
> {
  return {
    parse: (value) => McpExternalImagePreviewSchema.parse(value),
    plan: async (saved, input, access) => {
      const target = {
        pageId: input.pageId,
        revision: input.revision,
        edits: [],
      };
      validateBatchTargets(saved, { ...input, pages: [target] });
      const change = await prepare(
        requireBatchPage(saved.chapter, target),
        input,
        access.owner,
        access.guard,
      );
      access.guard();
      return {
        owner: access.owner,
        workId: saved.workId,
        membership: mcpBatchMembership(saved.chapter),
        pages: [
          {
            pageId: input.pageId,
            expectedRevision: input.revision,
            changes: [change],
            changedBlocks: change.changed ? 1 : 0,
            state: change.changed ? "pending" : "excluded",
            result: "not_started",
            errorCode: null,
          },
        ],
      };
    },
    request: (page, input, direction, plan) => ({
      chapterId: input.chapterId,
      pageId: page.pageId,
      revision: page.expectedRevision,
      direction,
      input,
      owner: plan.owner,
      change: page.changes[0],
    }),
    project: ({
      evidence: _e,
      recovery: _r,
      outcome: _o,
      beforeBlock: _b,
      afterBlock: _a,
      ...view
    }) => structuredClone(view),
    inspectTool: "carrot_get_external_image",
    exclusionWarning: "empty_or_unchanged_external_image_not_saved",
  };
}

/** Accept only the internally calculated image field; all other block fields are immutable. */
export function applyMcpExternalLettering(
  page: MangaPage,
  request: ExternalImageRequest,
) {
  const { beforeBlock: before, afterBlock: after } = request.change;
  if (
    !before ||
    !after ||
    before.id !== after.id ||
    request.input.command.kind !== "lettering" ||
    before.id !== request.input.command.blockId
  )
    throw new McpEditError(
      "invalid_edit",
      "Expected an internally reviewed lettering transition.",
    );
  const withoutImage = ({
    generatedLettering: _image,
    ...block
  }: TranslationBlock) => block;
  if (
    hashStableValue(withoutImage(before)) !==
    hashStableValue(withoutImage(after))
  )
    throw new McpEditError(
      "invalid_edit",
      "External lettering cannot modify text, geometry, order or formatting.",
    );
  const expected = request.direction === "undo" ? after : before;
  const replacement = request.direction === "undo" ? before : after;
  const matches = page.blocks.filter((block) => block.id === before.id);
  if (
    matches.length !== 1 ||
    hashStableValue(matches[0]) !== hashStableValue(expected)
  )
    throw new McpEditError(
      "revision_conflict",
      "Lettering block changed. Later user edits are never overwritten.",
    );
  return page.blocks.map((block) =>
    block.id === before.id ? structuredClone(replacement) : block,
  );
}
