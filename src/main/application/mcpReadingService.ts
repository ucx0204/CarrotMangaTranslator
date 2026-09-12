import type { ChapterSnapshot } from "../../shared/libraryTypes";
import type { McpPageReading } from "../../shared/mcpReadingTypes";
import type { BlockFormatDefaults } from "../../shared/blockFormat";
import type { SavePageBlocksRequest } from "../../shared/shareTypes";
import { createPageRevision } from "../../shared/pageRevision";
import {
  hashTranslationBlocks,
  hashStableValue,
} from "../../shared/blockFingerprint";
import { resolvePageBlockOrder } from "../../shared/blockReadingOrder";
import { McpEditError, isMcpSaveConflict } from "./mcpEditPolicy";
import { prepareMcpReading } from "./mcpReadingPolicy";

type Ports = {
  openChapter: (id: string) => Promise<ChapterSnapshot>;
  savePageBlocks: (
    request: SavePageBlocksRequest,
    assertCanCommit?: () => void,
  ) => Promise<ChapterSnapshot>;
  defaults: () => Promise<BlockFormatDefaults | undefined>;
  assertWritable: (chapterId: string, pageId: string) => Promise<void>;
  notifySaved: (chapterId: string, pageId: string) => void;
};
/** Append validated readings, never replace hand-edited blocks or invoke a model. */
export class McpReadingService {
  constructor(private readonly ports: Ports) {}
  async create(
    request: McpPageReading,
    assertAuthorized: () => void = () => {},
  ) {
    const { chapterId, pageId, revision } = request;
    assertAuthorized();
    await this.ports.assertWritable(chapterId, pageId);
    const chapter = await this.ports.openChapter(chapterId);
    const page = chapter.pages.find((p) => p.id === pageId);
    if (!page) throw new McpEditError("not_found", "Page not found.");
    if (page.analysisStatus === "running")
      throw new McpEditError(
        "editor_busy",
        "An app job is processing this page.",
      );
    const prepared = prepareMcpReading(
      page,
      request,
      await this.ports.defaults(),
    );
    assertAuthorized();
    const current = createPageRevision(page);
    const blockIds = prepared.blocks.map((block) => block.id);
    if (prepared.alreadyApplied)
      return { status: "already_applied", revision: current, blockIds };
    if (current !== revision)
      throw new McpEditError(
        "revision_conflict",
        "Read the page again before adding blocks.",
      );
    if (page.blocks.length + prepared.blocks.length > 5000)
      throw new McpEditError(
        "invalid_edit",
        "The page block limit would be exceeded.",
      );
    await this.ports.assertWritable(chapterId, pageId);
    assertAuthorized();
    const blocks = [...page.blocks, ...prepared.blocks];
    const blockOrder = [...resolvePageBlockOrder(page), ...blockIds];
    const saved = await this.save(
      {
        chapterId,
        pageId,
        expectedRevision: revision,
        baseUpdatedAt: page.updatedAt,
        baseBlocksHash: hashTranslationBlocks(page.blocks),
        baseBlockOrderHash: hashStableValue(page.blockOrder ?? null),
        blocks,
        blockOrder,
        saveReason: "manual",
      },
      assertAuthorized,
    );
    const updated = saved.pages.find((p) => p.id === pageId);
    if (!updated) throw new McpEditError("not_found", "Saved page is missing.");
    this.ports.notifySaved(chapterId, pageId);
    return { status: "saved", revision: createPageRevision(updated), blockIds };
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
          "A concurrent edit won the save. Read the page again.",
          { cause: error },
        );
      throw error;
    }
  }
}
