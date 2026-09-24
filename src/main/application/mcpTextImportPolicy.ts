import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import { gatherText, buildTranslatedTextImport } from "../../shared/gatherText";
import {
  McpTextImportPreviewSchema,
  type McpTextImportPreview,
  type McpTextImportSourceInfo,
  type McpTextImportChange,
  type McpTextImportDiagnostic,
} from "../../shared/mcpTextExchange";
import type { McpTextExchangeBinding } from "../../shared/mcpExchangeFiles";
import type { McpTranslationPatch } from "../../shared/mcpEditingTypes";
import type { BatchPlan, BatchPolicy } from "./mcpPageBatchTypes";
import type { McpContextSnapshot } from "./mcpContextEditPolicy";
import {
  validateBatchTargets,
  requireBatchPage,
  mcpBatchMembership,
} from "./mcpPageBatchPolicy";
import { translationBatchPolicy } from "./mcpTranslationBatchPolicy";
import {
  planMcpReviewFile,
  projectReviewImportFields,
  reviewFileChange,
  blockKey,
  type TextImportSnapshotRequest,
} from "./mcpReviewImportPolicy";
import { McpEditError } from "./mcpEditPolicy";

type Input = McpTextImportPreview & { chapterId: string };
export type McpTextImportPlan = BatchPlan<McpTextImportChange> & {
  source: McpTextExchangeBinding;
  input: McpTextImportSourceInfo;
  pageNames: Record<string, string>;
  diagnostics: McpTextImportDiagnostic[];
};
export type McpTextImportRequest =
  | ({ kind: "txt"; pageName: string } & McpTranslationPatch)
  | ({ kind: "review" } & TextImportSnapshotRequest);
type Source = {
  content: string;
  info: McpTextImportSourceInfo;
  verify: () => Promise<void>;
};
export type McpTextImportSourcePort = {
  use: <T>(
    owner: string,
    input: { uploadId: string; format: "txt" | "csv" | "tsv"; sha256: string },
    guard: () => void,
    consume: (source: Source) => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
};

type TextImportPolicy = BatchPolicy<
  Input,
  McpTextImportChange,
  McpTextImportRequest,
  McpTextImportChange,
  McpTextImportPlan
>;
type NativeTextPlan = Awaited<ReturnType<typeof translationBatchPolicy.plan>>;

export function createMcpTextImportPolicy(
  sources: McpTextImportSourcePort,
  checkSource: (
    binding: McpTextExchangeBinding,
    guard: () => void,
    signal?: AbortSignal,
  ) => Promise<void>,
): TextImportPolicy {
  return {
    parse: (value) => {
      const input = McpTextImportPreviewSchema.parse(value);
      return { ...input, chapterId: input.source.chapterId };
    },
    plan: (saved, input, access) =>
      sources.use(
        access.owner,
        {
          uploadId: input.uploadId,
          sha256: input.sha256,
          format: input.source.options.format,
        },
        access.guard,
        async (source) => {
          await checkSource(input.source, access.guard, access.signal);
          validateSelection(saved, input);
          const planned =
            input.source.options.format === "txt"
              ? await planTxt(saved, input, source.content, access)
              : planReview(saved, input, source.content);
          await source.verify();
          access.guard();
          return {
            ...planned,
            source: structuredClone(input.source),
            input: source.info,
            pageNames: Object.fromEntries(
              input.selection.map(({ pageId }) => [
                pageId,
                requireImportPage(saved.chapter, pageId).name,
              ]),
            ),
          };
        },
        access.signal,
      ),
    request: requestImport,
    project: (change) => structuredClone(change),
    inspectTool: "carrot_get_text_file_import",
    exclusionWarning: "inspect_text_import_exclusions",
  };
}

const requestImport: TextImportPolicy["request"] = (
  page,
  input,
  direction,
  plan,
) => {
  const common = {
    chapterId: input.chapterId,
    pageId: page.pageId,
    revision: page.expectedRevision as McpTranslationPatch["revision"],
    pageName: plan.pageNames[page.pageId],
  };
  const changes = page.changes.filter((change) => change.changed);
  const selected = (change: McpTextImportChange) =>
    direction === "undo" ? change.before : change.after;
  return input.source.options.format === "txt"
    ? {
        ...common,
        kind: "txt",
        edits: changes.map((change) => ({
          blockId: change.blockId,
          translatedText: selected(change).translatedText,
        })),
      }
    : {
        ...common,
        kind: "review",
        fields: changes.map((change) => ({
          blockId: change.blockId,
          value: structuredClone(selected(change)),
        })),
      };
};

function targets(input: Input) {
  return input.selection.map((selected) => {
    const page = input.source.pages.find(
      (page) => page.pageId === selected.pageId,
    );
    if (!page)
      throw new McpEditError(
        "invalid_edit",
        "Select blocks only in the reviewed page selection.",
      );
    return {
      ...page,
      edits: selected.blockIds.map((blockId) => ({ blockId })),
    };
  });
}
function validateSelection(saved: McpContextSnapshot, input: Input) {
  const pages = targets(input);
  if (input.source.workId !== saved.workId)
    throw new McpEditError(
      "revision_conflict",
      "The reviewed work membership changed.",
    );
  validateBatchTargets(saved, { ...input, pages });
  for (const page of pages) {
    const stored = requireBatchPage(saved.chapter, page);
    if (
      page.edits.some(
        (edit) => !stored.blocks.some((block) => block.id === edit.blockId),
      )
    )
      throw new McpEditError(
        "not_found",
        "Select existing blocks in their actual saved pages.",
      );
  }
}

async function planTxt(
  saved: McpContextSnapshot,
  input: Input,
  content: string,
  access: { owner: string; guard: () => void; signal?: AbortSignal },
) {
  const parsed = parseTxt(saved, input, content);
  const pages = targets(input).map((target) => {
    const page = requireBatchPage(saved.chapter, target);
    return {
      ...target,
      edits: target.edits.map(({ blockId }) => ({
        blockId,
        reason: "Apply explicitly selected native TXT import text.",
        translatedText:
          parsed.updates.get(blockKey(page.id, blockId)) ??
          requireImportBlock(page, blockId).translatedText,
      })),
    };
  });
  const native = await translationBatchPolicy.plan(
    saved,
    {
      chapterId: input.chapterId,
      contextRevision: input.contextRevision,
      requestId: input.requestId,
      reason: input.reason,
      allowEmpty: input.allowEmpty,
      pages,
    },
    access,
  );
  return {
    ...native,
    pages: native.pages.map((planned) =>
      projectTxtPage(planned, requireImportPage(saved.chapter, planned.pageId)),
    ),
    diagnostics: parsed.diagnostics,
  };
}
function projectTxtPage(
  planned: NativeTextPlan["pages"][number],
  page: MangaPage,
) {
  return {
    ...planned,
    changes: planned.changes.map((change) => {
      const block = requireImportBlock(page, change.blockId);
      const before = projectReviewImportFields(block);
      return {
        pageId: page.id,
        blockId: block.id,
        before,
        after: { ...before, translatedText: change.proposedText },
        changed: change.changed,
        excludedReason: change.excludedReason,
        warnings: change.excludedReason ? ["generated_lettering_excluded"] : [],
      };
    }),
  };
}

function parseTxt(saved: McpContextSnapshot, input: Input, content: string) {
  const gathered = input.source.pages.flatMap((target) => {
    const page = saved.chapter.pages.find((page) => page.id === target.pageId);
    if (!page)
      throw new McpEditError("not_found", "The gathered page is absent.");
    return gatherText({
      chapter: saved.chapter,
      page,
      scope: "page",
      direction: input.source.direction,
    });
  });
  const parsed = buildTranslatedTextImport(gathered, content);
  if (parsed.updates.length > 1000 || parsed.warnings.length > 1000)
    throw new McpEditError(
      "invalid_edit",
      "TXT review supports at most 1000 proposed updates or mapping warnings; nothing was truncated.",
    );
  const updates = new Map(
    parsed.updates.map((item) => [
      blockKey(item.pageId, item.blockId),
      item.translatedText,
    ]),
  );
  if (updates.size !== parsed.updates.length)
    throw new McpEditError(
      "invalid_edit",
      "Repeated TXT sections propose duplicate block updates. Review distinct targets.",
    );
  const selectedKeys = new Set(
    input.selection.flatMap((page) =>
      page.blockIds.map((id) => blockKey(page.pageId, id)),
    ),
  );
  const ignored: McpTextImportDiagnostic[] = parsed.updates
    .filter((item) => !selectedKeys.has(blockKey(item.pageId, item.blockId)))
    .map(({ pageId, blockId }) => ({
      code: "unselected_txt_update_ignored",
      pageId,
      blockId,
    }));
  return {
    updates,
    diagnostics: [
      ...ignored,
      ...parsed.warnings.map((message) => ({
        code: "native_txt_mapping_warning",
        message,
      })),
    ],
  };
}
function planReview(saved: McpContextSnapshot, input: Input, content: string) {
  const native = planMcpReviewFile(saved.chapter, input, content);
  const pages = targets(input).map((target) => {
    const page = requireBatchPage(saved.chapter, target);
    const changes = target.edits.map(({ blockId }) => {
      const block = requireImportBlock(page, blockId);
      return reviewFileChange(
        page,
        block,
        native.changes.get(blockKey(page.id, blockId)) ?? block,
        input.allowEmpty,
      );
    });
    return batchPage(page, target.revision, changes);
  });
  pages.sort(
    (a, b) =>
      saved.chapter.pages.findIndex((page) => page.id === a.pageId) -
      saved.chapter.pages.findIndex((page) => page.id === b.pageId),
  );
  return {
    workId: saved.workId,
    membership: mcpBatchMembership(saved.chapter),
    pages,
    diagnostics: native.diagnostics,
  };
}
function batchPage(
  page: MangaPage,
  revision: string,
  changes: McpTextImportChange[],
) {
  const changedBlocks = changes.filter((change) => change.changed).length;
  return {
    pageId: page.id,
    expectedRevision: revision,
    changes,
    changedBlocks,
    state: changedBlocks ? ("pending" as const) : ("unchanged" as const),
    result: "not_started" as const,
    errorCode: null,
  };
}
function requireImportPage(chapter: ChapterSnapshot, pageId: string) {
  const page = chapter.pages.find((item) => item.id === pageId);
  if (!page)
    throw new McpEditError("not_found", "A reviewed import page is absent.");
  return page;
}
function requireImportBlock(page: MangaPage, blockId: string) {
  const block = page.blocks.find((item) => item.id === blockId);
  if (!block)
    throw new McpEditError("not_found", "A reviewed import block is absent.");
  return block;
}
