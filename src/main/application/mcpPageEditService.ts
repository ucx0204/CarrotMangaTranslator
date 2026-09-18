import {
  applyMcpTypographySnapshots,
  type TypographySnapshotRequest,
} from "./mcpTypographyBatchPolicy";
import {
  applyMcpFormatSnapshots,
  type FormatSnapshotRequest,
} from "./mcpFormatBatchPolicy";
import { assertMcpBatchMembership } from "./mcpPageBatchPolicy";
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
import type { McpSourceRectPatch } from "../../shared/mcpSourceRect";
import type { PageRevision } from "../../shared/pageRevisionTypes";
import type { SavePageBlocksRequest } from "../../shared/shareTypes";
import { createPageRevision } from "../../shared/pageRevision";
import { resolvePageBlockOrder } from "../../shared/blockReadingOrder";
import {
  hashTranslationBlocks,
  hashStableValue,
} from "../../shared/blockFingerprint";
import { applyMcpBlockPatch, applyMcpReadingOrder } from "./mcpBlockEditPolicy";
import { applyMcpSourceRect } from "./mcpSourceRectPolicy";
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
  async updateSourceRect(
    request: McpSourceRectPatch,
    assertAuthorized: () => void = () => {},
  ) {
    const result = await this.mutate(
      request,
      assertAuthorized,
      (_chapter, page) => {
        // Unlike legacy scalar edits, even a no-op requires a fresh snapshot.
        // A lost response is resolved by re-reading, not by replaying stale edits.
        assertCurrentRevision(page, request.revision);
        return applyMcpSourceRect(page, request);
      },
    );
    return {
      chapterId: request.chapterId,
      pageId: request.pageId,
      blockId: request.blockId,
      status: result.status,
      revision: createPageRevision(result.page),
      ...result.data,
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
  /** Internal snapshot for owned structural plans; never returned as a remote object. */
  async readStructurePage(target: { chapterId: string; pageId: string }) {
    return requirePage(
      await this.ports.openChapter(target.chapterId),
      target.pageId,
    );
  }
  async commitStructure(
    target: Target,
    snapshot: Pick<MangaPage, "blocks" | "blockOrder">,
    reviewHash: string,
    authorize: () => void,
    onCommitted: (page: MangaPage) => void,
  ) {
    const result = await this.mutate(
      target,
      authorize,
      (_chapter, page) => {
        assertCurrentRevision(page, target.revision);
        if (hashStableValue(page.soundEffectReview ?? null) !== reviewHash)
          throw new McpEditError(
            "revision_conflict",
            "Sound-effect references changed. Inspect the page again.",
          );
        return { ...structuredClone(snapshot), changed: true, result: null };
      },
      onCommitted,
    );
    return result.page;
  }
  /** Strict text-only commit with a receipt published before UI notification.
   * The context read lease is acquired only AFTER the native page lease. */
  async commitTranslationBatch(
    request: McpTranslationPatch,
    membership: string,
    authorize: () => void,
    onCommitted: (page: MangaPage) => void,
    scope: <T>(run: () => Promise<T>) => Promise<T>,
  ): Promise<void> {
    await this.mutate(
      request,
      authorize,
      (chapter, page) => {
        assertCurrentRevision(page, request.revision);
        assertMcpBatchMembership(chapter, membership);
        const ids = new Set(request.edits.map((edit) => edit.blockId));
        if (
          page.blocks.some(
            (block) => ids.has(block.id) && block.generatedLettering,
          )
        )
          throw new McpEditError(
            "invalid_edit",
            "Generated lettering cannot be changed by this text-only batch.",
          );
        const patch = applyMcpTranslations(page, request.edits);
        return {
          blocks: patch.blocks,
          blockOrder: page.blockOrder,
          changed: patch.previous.length > 0,
          result: null,
        };
      },
      onCommitted,
      scope,
    );
  }
  /** Exact optional state is restored through the same native page transaction. */
  commitFormatBatch(
    request: FormatSnapshotRequest,
    membership: string,
    authorize: () => void,
    onCommitted: (page: MangaPage) => void,
    scope: <T>(run: () => Promise<T>) => Promise<T>,
  ): Promise<void> {
    return this.commitSnapshotBatch(
      request,
      membership,
      authorize,
      onCommitted,
      scope,
      applyMcpFormatSnapshots,
    );
  }
  commitTypographyBatch(
    request: TypographySnapshotRequest,
    membership: string,
    authorize: () => void,
    onCommitted: (page: MangaPage) => void,
    scope: <T>(run: () => Promise<T>) => Promise<T>,
  ): Promise<void> {
    return this.commitSnapshotBatch(
      request,
      membership,
      authorize,
      onCommitted,
      scope,
      applyMcpTypographySnapshots,
    );
  }
  /** Internal calculated snapshots only; transport never accepts this callback or raw blocks. */
  async commitSnapshotBatch<R extends Target>(
    request: R,
    membership: string,
    authorize: () => void,
    onCommitted: (page: MangaPage) => void,
    scope: <T>(run: () => Promise<T>) => Promise<T>,
    apply: (page: MangaPage, request: R) => TranslationBlock[] | Pick<MangaPage, "blocks" | "blockOrder">,
  ): Promise<void> {
    await this.mutate(
      request,
      authorize,
      (chapter, page) => {
        assertCurrentRevision(page, request.revision);
        assertMcpBatchMembership(chapter, membership);
        const projected = apply(page, request);
        const snapshot = Array.isArray(projected)
          ? { blocks: projected, blockOrder: page.blockOrder } : projected;
        return {
          ...snapshot,
          changed: hashStableValue(snapshot.blocks) !== hashStableValue(page.blocks) ||
            hashStableValue(snapshot.blockOrder ?? null) !== hashStableValue(page.blockOrder ?? null),
          result: null,
        };
      },
      onCommitted,
      scope,
    );
  }
  private mutate<T>(
    target: Target,
    authorize: () => void,
    calculate: (chapter: ChapterSnapshot, page: MangaPage) => Change<T>,
    onCommitted?: (page: MangaPage) => void,
    scope?: <R>(run: () => Promise<R>) => Promise<R>,
  ) {
    const execute = (guard: () => void) => {
      const run = () => this.mutateOwned(target, guard, calculate, onCommitted);
      return scope ? scope(run) : run();
    };
    return this.ports.withPageEdit
      ? this.ports.withPageEdit(target, authorize, execute)
      : execute(authorize);
  }
  /** Runs after the native page lease when the app composition provides one. */
  private async mutateOwned<T>(
    target: Target,
    authorize: () => void,
    calculate: (chapter: ChapterSnapshot, page: MangaPage) => Change<T>,
    onCommitted?: (page: MangaPage) => void,
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
    assertCurrentRevision(page, target.revision);
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
    // Publish a receipt before notification: a failed refresh must not replay a committed edit.
    onCommitted?.(updated);
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
function assertCurrentRevision(page: MangaPage, revision: string): void {
  if (createPageRevision(page) !== revision)
    throw new McpEditError(
      "revision_conflict",
      "The page changed since it was read. Read it again before editing.",
    );
}
function requirePage(chapter: ChapterSnapshot, pageId: string): MangaPage {
  const page = chapter.pages.find((item) => item.id === pageId);
  if (!page) throw new McpEditError("not_found", "Page not found.");
  return page;
}
