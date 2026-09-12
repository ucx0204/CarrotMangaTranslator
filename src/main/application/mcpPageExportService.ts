import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import { createPageRevision } from "../../shared/pageRevision";
import type { McpOperationContext } from "./mcpOperationService";
import { McpEditError } from "./mcpEditPolicy";

type Target = { chapterId: string; pageId: string; revision: string };
type Artifact = {
  url: string;
  mimeType: "image/png";
  bytes: number;
  sha256: string;
  expiresAt: number;
  access: string;
};
type Ports = {
  openChapter: (chapterId: string) => Promise<ChapterSnapshot>;
  render: (page: MangaPage, signal: AbortSignal) => Promise<Buffer>;
  store: (
    bytes: Buffer,
    assertAccess: () => Promise<void>,
  ) => Promise<Artifact>;
  assertImageAccess: () => Promise<void>;
};
/** Export reads an immutable page version and never starts OCR, erasure or translation. */
export class McpPageExportService {
  constructor(private readonly ports: Ports) {}
  async export(target: Target, context: McpOperationContext) {
    const assertAccess = async () => {
      context.assertAuthorized();
      await this.ports.assertImageAccess();
      const page = await this.load(target);
      if (createPageRevision(page) !== target.revision)
        throw new McpEditError(
          "revision_conflict",
          "Page changed. Export its current revision instead.",
        );
      context.assertAuthorized();
    };
    await assertAccess();
    context.progress({ phase: "rendering" });
    const page = await this.load(target);
    const bytes = await this.ports.render(page, context.signal);
    await assertAccess();
    const artifact = await this.ports.store(bytes, assertAccess);
    context.progress({ phase: "done", completed: 1, total: 1 });
    return {
      ...target,
      ...artifact,
      width: page.width,
      height: page.height,
      kind: "rendered-page-png",
      performed: ["render", "export"],
    };
  }
  private async load(target: Target) {
    const page = (await this.ports.openChapter(target.chapterId)).pages.find(
      (item) => item.id === target.pageId,
    );
    if (!page) throw new McpEditError("not_found", "Page not found.");
    return page;
  }
}
