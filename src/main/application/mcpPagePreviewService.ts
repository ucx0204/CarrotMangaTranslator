import type { MangaPage } from "../../shared/libraryTypes";
import type { McpLibraryReadPort } from "./mcpLibraryReadService";

type PreviewImage = { data: string; width: number; height: number };

type PreviewPort = {
  openChapter: McpLibraryReadPort["openChapter"];
  renderApprovedPreview: (page: MangaPage) => Promise<PreviewImage>;
};

/** Resolves opaque IDs; the image adapter must enforce the existing redaction policy. */
export class McpPagePreviewService {
  private readonly port: PreviewPort;

  constructor(port: PreviewPort) {
    this.port = port;
  }

  async getPreview(chapterId: string, pageId: string) {
    const chapter = await this.port.openChapter(chapterId);
    const page = chapter.pages.find((candidate) => candidate.id === pageId);
    if (!page) throw new Error("Page not found in this chapter.");
    const image = await this.port.renderApprovedPreview(page);
    return {
      pageId: page.id,
      updatedAt: page.updatedAt,
      sourceWidth: page.width,
      sourceHeight: page.height,
      previewWidth: image.width,
      previewHeight: image.height,
      imageData: image.data,
    };
  }
}
