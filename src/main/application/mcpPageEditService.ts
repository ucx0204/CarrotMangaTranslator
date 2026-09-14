import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type { McpTranslationPatch } from "../../shared/mcpEditingTypes";
import type { SavePageBlocksRequest } from "../../shared/shareTypes";
import { createPageRevision } from "../../shared/pageRevision";
import {
  hashTranslationBlocks,
  hashStableValue,
} from "../../shared/blockFingerprint";
import {
  applyMcpTranslations,
  isMcpSaveConflict,
  McpEditError,
  projectMcpBlocks,
} from "./mcpEditPolicy";

type Ports = {
  openChapter: (chapterId: string) => Promise<ChapterSnapshot>;
  savePageBlocks: (
    request: SavePageBlocksRequest,
    assertCanCommit?: () => void,
  ) => Promise<ChapterSnapshot>;
  assertWritable: (chapterId: string, pageId: string) => Promise<void>;
  notifySaved: (chapterId: string, pageId: string) => void;
};
export class McpPageEditService {
  constructor(private readonly ports: Ports) {}
  async read(
    chapterId: string,
    pageId: string,
    window: { offset: number; limit: number },
  ) {
    const page = await this.load(chapterId, pageId);
    return {
      chapterId,
      pageId,
      revision: createPageRevision(page),
      width: page.width,
      height: page.height,
      blockOrder: page.blockOrder,
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
    const { chapterId, pageId, revision, edits } = request;
    assertAuthorized();
    await this.ports.assertWritable(chapterId, pageId);
    const page = await this.load(chapterId, pageId);
    assertAuthorized();
    if (page.analysisStatus === "running")
      throw new McpEditError(
        "editor_busy",
        "This page has an active app job. Retry after it finishes.",
      );
    const patch = applyMcpTranslations(page, edits);
    const current = createPageRevision(page);
    if (!patch.previous.length)
      return {
        status: "already_applied",
        revision: current,
        changed: 0,
        previousTranslations: [],
      };
    if (current !== revision)
      throw new McpEditError(
        "revision_conflict",
        "The page changed since it was read. Read it again before editing.",
      );
    await this.ports.assertWritable(chapterId, pageId);
    assertAuthorized();
    const saved = await this.save(
      {
        chapterId,
        pageId,
        expectedRevision: revision,
        baseUpdatedAt: page.updatedAt,
        baseBlocksHash: hashTranslationBlocks(page.blocks),
        baseBlockOrderHash: hashStableValue(page.blockOrder ?? null),
        blocks: patch.blocks,
        blockOrder: page.blockOrder,
        saveReason: "manual",
      },
      assertAuthorized,
    );
    const updated = requirePage(saved, pageId);
    this.ports.notifySaved(chapterId, pageId);
    return {
      status: "saved",
      revision: createPageRevision(updated),
      changed: patch.previous.length,
      previousTranslations: patch.previous,
    };
  }
  private async load(chapterId: string, pageId: string): Promise<MangaPage> {
    return requirePage(await this.ports.openChapter(chapterId), pageId);
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
