import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type {
  McpPageReading,
  McpReadingBlock,
} from "../../shared/mcpReadingTypes";
import { createPageRevision } from "../../shared/pageRevision";
import type { McpOperationContext } from "./mcpOperationService";
import { McpEditError } from "./mcpEditPolicy";

type Target = Pick<
  McpPageReading,
  "chapterId" | "pageId" | "revision" | "requestId"
>;
type Ports = {
  openChapter: (chapterId: string) => Promise<ChapterSnapshot>;
  recognize: (
    page: MangaPage,
    context: McpOperationContext,
  ) => Promise<{
    blocks: McpReadingBlock[];
    engine: string;
    noTextDetected: boolean;
    effectReviewCandidates: number;
  }>;
  saveReading: (
    reading: McpPageReading,
    assertCanCommit: () => void,
  ) => Promise<{
    status: string;
    revision: string;
    blockIds: string[];
  }>;
};
/** OCR-only: recognize through the app port, then append an untranslated reading.
 * Existing blocks are never replaced and no translation endpoint is available here. */
export class McpOcrService {
  constructor(private readonly ports: Ports) {}
  async run(target: Target, context: McpOperationContext) {
    context.assertAuthorized();
    const page = await this.load(target);
    if (page.blocks.length)
      throw new McpEditError(
        "invalid_edit",
        "OCR-only currently requires a page without blocks. Existing manual readings will not be replaced.",
      );
    context.progress({ phase: "ocr_preparing" });
    const reading = await this.ports.recognize(page, context);
    context.assertAuthorized();
    await this.load(target);
    const saved = reading.blocks.length
      ? await this.ports.saveReading(
          { ...target, blocks: reading.blocks },
          context.assertAuthorized,
        )
      : { status: "no_blocks", revision: target.revision, blockIds: [] };
    return {
      ...saved,
      chapterId: target.chapterId,
      pageId: target.pageId,
      engine: reading.engine,
      performed: ["ocr"],
      noTextDetected: reading.noTextDetected,
      effectReviewCandidates: reading.effectReviewCandidates,
      needsReview: true,
    };
  }
  private async load(target: Target) {
    const page = (await this.ports.openChapter(target.chapterId)).pages.find(
      (item) => item.id === target.pageId,
    );
    if (!page) throw new McpEditError("not_found", "Page not found.");
    if (createPageRevision(page) !== target.revision)
      throw new McpEditError(
        "revision_conflict",
        "Page changed. Read it again before OCR.",
      );
    return page;
  }
}
