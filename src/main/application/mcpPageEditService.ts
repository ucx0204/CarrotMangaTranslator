import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import type {
  McpPageEditScope,
  McpTranslationPatch,
} from "../../shared/mcpEditingTypes";
import type {
  McpBlockPatch,
  McpReadingOrder,
} from "../../shared/mcpBlockEditing";
import type { PageRevision } from "../../shared/pageRevisionTypes";
import type { SavePageBlocksRequest } from "../../shared/shareTypes";
import { createPageRevision } from "../../shared/pageRevision";
import { resolvePageBlockOrder } from "../../shared/blockReadingOrder";
import {
  hashTranslationBlocks,
  hashStableValue,
} from "../../shared/blockFingerprint";
import { applyMcpBlockPatch, applyMcpReadingOrder } from "./mcpBlockEditPolicy";
import {
  applyMcpTranslations,
  isMcpSaveConflict,
  McpEditError,
  projectMcpBlocks,
} from "./mcpEditPolicy";

type Ports = {
  withPageEdit?: McpPageEditScope;
  openChapter: (chapterId: string) => Promise<ChapterSnapshot>;
  savePageBlocks: (
    request: SavePageBlocksRequest,
    assertCanCommit?: () => void,
  ) => Promise<ChapterSnapshot>;
  assertWritable: (chapterId: string, pageId: string) => Promise<void>;
  notifySaved: (chapterId: string, pageId: string) => void;
};
type Target = { chapterId: string; pageId: string; revision: string };
type Change<T> = {
  blocks: TranslationBlock[];
  blockOrder?: string[];
  changed: boolean;
  result: T;
};
export class McpPageEditService {
  constructor(private readonly ports: Ports) {}
  async read(
    chapterId: string,
    pageId: string,
    window: { offset: number; limit: number },
  ) {
    const page = requirePage(await this.ports.openChapter(chapterId), pageId);
    return {
      chapterId,
      pageId,
      revision: createPageRevision(page),
      width: page.width,
      height: page.height,
      blockOrder: page.blockOrder,
      effectiveBlockOrder: resolvePageBlockOrder(page),
      total: page.blocks.length,
      offset: window.offset,
      limit: window.limit,
      nextOffset:
        window.offset + window.limit < page.blocks.length
          ? window.offset + window.limit
          : null,
      blocks: projectMcpBlocks(page, window.offset, window.limit),
    };
  }
  async update(
    request: McpTranslationPatch,
    assertAuthorized: () => void = () => {},
  ) {
    const result = await this.mutate(
      request,
      assertAuthorized,
      (_chapter, page) => {
        const patch = applyMcpTranslations(page, request.edits);
        return {
          blocks: patch.blocks,
          blockOrder: page.blockOrder,
          changed: patch.previous.length > 0,
          result: patch.previous,
        };
      },
    );
    return {
      status: result.status,
      revision: createPageRevision(result.page),
      changed: result.data.length,
      previousTranslations: result.data,
    };
  }
  async updateBlocks(
    request: McpBlockPatch,
    assertAuthorized: () => void = () => {},
  ) {
    const result = await this.mutate(
      request,
      assertAuthorized,
      (chapter, page) => {
        const patch = applyMcpBlockPatch(chapter, page, request.edits);
        return {
          blocks: patch.blocks,
          blockOrder: page.blockOrder,
          changed: patch.changedBlockIds.length > 0,
          result: {
            changedBlockIds: patch.changedBlockIds,
            warnings: patch.warnings,
          },
        };
      },
    );
    const selected = new Set(request.edits.map((edit) => edit.blockId));
    return {
      status: result.status,
      revision: createPageRevision(result.page),
      ...result.data,
      blocks: projectMcpBlocks(
        {
          ...result.page,
          blocks: result.page.blocks.filter((block) => selected.has(block.id)),
        },
        0,
        request.edits.length,
      ),
    };
  }
  async reorder(
    request: McpReadingOrder,
    assertAuthorized: () => void = () => {},
  ) {
    const result = await this.mutate(
      request,
      assertAuthorized,
      (_chapter, page) => {
        const patch = applyMcpReadingOrder(page, request);
        return {
          blocks: page.blocks,
          blockOrder: patch.blockOrder,
          changed: patch.changed,
          result: {
            changed: patch.changed,
            previousBlockOrder: resolvePageBlockOrder(page),
          },
        };
      },
    );
    return {
      status: result.status,
      revision: createPageRevision(result.page),
      ...result.data,
      blockOrder: resolvePageBlockOrder(result.page),
    };
  }
  private mutate<T>(
    target: Target,
    authorize: () => void,
    calculate: (chapter: ChapterSnapshot, page: MangaPage) => Change<T>,
  ) {
    return this.ports.withPageEdit
      ? this.ports.withPageEdit(target, authorize, (guard) =>
          this.mutateOwned(target, guard, calculate),
        )
      : this.mutateOwned(target, authorize, calculate);
  }
  /** Runs after the native page lease when the app composition provides one. */
  private async mutateOwned<T>(
    target: Target,
    authorize: () => void,
    calculate: (chapter: ChapterSnapshot, page: MangaPage) => Change<T>,
  ) {
    authorize();
    await this.ports.assertWritable(target.chapterId, target.pageId);
    const chapter = await this.ports.openChapter(target.chapterId);
    const page = requirePage(chapter, target.pageId);
    authorize();
    if (page.analysisStatus === "running")
      throw new McpEditError(
        "editor_busy",
        "This page has an active app job. Retry after it finishes.",
      );
    const change = calculate(chapter, page);
    if (!change.changed)
      return { status: "already_applied" as const, page, data: change.result };
    if (createPageRevision(page) !== target.revision)
      throw new McpEditError(
        "revision_conflict",
        "The page changed since it was read. Read it again before editing.",
      );
    await this.ports.assertWritable(target.chapterId, target.pageId);
    authorize();
    const saved = await this.save(
      {
        chapterId: target.chapterId,
        pageId: target.pageId,
        expectedRevision: target.revision as PageRevision,
        baseUpdatedAt: page.updatedAt,
        baseBlocksHash: hashTranslationBlocks(page.blocks),
        baseBlockOrderHash: hashStableValue(page.blockOrder ?? null),
        blocks: change.blocks,
        blockOrder: change.blockOrder,
        saveReason: "manual",
      },
      authorize,
    );
    const updated = requirePage(saved, target.pageId);
    this.ports.notifySaved(target.chapterId, target.pageId);
    return { status: "saved" as const, page: updated, data: change.result };
  }
  private async save(
    request: SavePageBlocksRequest,
    assertCanCommit: () => void,
  ) {
    try {
      return await this.ports.savePageBlocks(request, assertCanCommit);
    } catch (error) {
      if (isMcpSaveConflict(error))
        throw new McpEditError(
          "revision_conflict",
          "A concurrent app edit won the save. Read the page again.",
          { cause: error },
        );
      throw error;
    }
  }
}
function requirePage(chapter: ChapterSnapshot, pageId: string): MangaPage {
  const page = chapter.pages.find((item) => item.id === pageId);
  if (!page) throw new McpEditError("not_found", "Page not found.");
  return page;
}
