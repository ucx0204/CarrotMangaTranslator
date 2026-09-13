import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type { PixelRect } from "../../shared/region";
import { createPageRevision } from "../../shared/pageRevision";
import { McpEditError } from "./mcpEditPolicy";

type Image = { data: string; width: number; height: number };
type Ports = {
  openChapter: (id: string) => Promise<ChapterSnapshot>;
  crop: (page: MangaPage, rect: PixelRect) => Promise<Image>;
  render: (page: MangaPage) => Promise<Image>;
};

/** Resolve IDs and verify page revision after image work; no paths leave this boundary. */
export class McpPageImageService {
  constructor(private readonly ports: Ports) {}
  async read(chapterId: string, pageId: string, rect?: PixelRect) {
    const page = await this.load(chapterId, pageId);
    if (rect) assertCrop(page, rect);
    const revision = createPageRevision(page);
    const image = rect
      ? await this.ports.crop(page, rect)
      : await this.ports.render(page);
    if (createPageRevision(await this.load(chapterId, pageId)) !== revision)
      throw new McpEditError(
        "revision_conflict",
        "The page changed during rendering. Request the image again.",
      );
    return {
      chapterId,
      pageId,
      revision,
      kind: rect ? "source-crop" : "rendered-page",
      sourceWidth: page.width,
      sourceHeight: page.height,
      crop: rect ?? null,
      width: image.width,
      height: image.height,
      pixelMapping: rect
        ? {
            originX: rect.x,
            originY: rect.y,
            scaleX: rect.w / image.width,
            scaleY: rect.h / image.height,
          }
        : {
            originX: 0,
            originY: 0,
            scaleX: page.width / image.width,
            scaleY: page.height / image.height,
          },
      imageData: image.data,
    };
  }
  private async load(chapterId: string, pageId: string) {
    const page = (await this.ports.openChapter(chapterId)).pages.find(
      (p) => p.id === pageId,
    );
    if (!page) throw new McpEditError("not_found", "Page not found.");
    return page;
  }
}

function assertCrop(page: MangaPage, rect: PixelRect): void {
  if (
    !Object.values(rect).every(Number.isSafeInteger) ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.w < 1 ||
    rect.h < 1 ||
    rect.x + rect.w > page.width ||
    rect.y + rect.h > page.height
  )
    throw new McpEditError(
      "invalid_edit",
      "Crop must be an integer pixel rectangle wholly inside the source page.",
    );
}
