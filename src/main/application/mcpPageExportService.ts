import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import { createPageRevision } from "../../shared/pageRevision";
import {
  McpPageExportOptionsSchema,
  type McpPageExportOptions,
} from "../../shared/mcpOutputFormats";
import type { McpOperationContext } from "./mcpOperationService";
import { McpEditError } from "./mcpEditPolicy";

type Target = {
  chapterId: string;
  pageId: string;
  revision: string;
  sourceNameFingerprint?: string;
};
type ImageMime =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/vnd.adobe.photoshop";
type Artifact<M extends ImageMime = ImageMime> = {
  retainedOutputId?: string;
  url: string;
  mimeType: M;
  bytes: number;
  sha256: string;
  expiresAt: number;
  access: string;
};
type SourceTarget = Target & { sourceFingerprint?: string };
type Writer<A extends Artifact> = (
  bytes: Buffer,
  assertAccess: () => Promise<void>,
  target?: SourceTarget,
) => Promise<A>;
type Renderer = (page: MangaPage, signal: AbortSignal) => Promise<Buffer>;
type Ports = {
  openChapter: (chapterId: string) => Promise<ChapterSnapshot>;
  render: Renderer;
  store: Writer<Artifact<"image/png">>;
  image?: {
    render: (
      page: MangaPage,
      signal: AbortSignal,
      options: McpPageExportOptions,
    ) => Promise<Buffer>;
    store: (
      bytes: Buffer,
      format: McpPageExportOptions["format"],
      assertAccess: () => Promise<void>,
      target?: SourceTarget,
    ) => Promise<Artifact>;
  };
  assertImageAccess: () => Promise<void>;
  bindSource?: (page: MangaPage) => Promise<{
    fingerprint: string;
    sourceNameFingerprint?: string;
    verify: (page?: MangaPage, sourceNameFingerprint?: string) => Promise<void>;
  }>;
};
/** Export reads an immutable page version and never starts OCR, erasure or translation. */
export class McpPageExportService {
  constructor(private readonly ports: Ports) {}
  export(
    target: Target,
    context: McpOperationContext,
    retainedAccess?: () => Promise<void>,
  ) {
    return this.exportWith(
      target,
      context,
      this.ports.render,
      this.ports.store,
      retainedAccess,
    );
  }
  async exportImage(
    target: Target & { imageExport: McpPageExportOptions },
    context: McpOperationContext,
    retainedAccess?: () => Promise<void>,
  ) {
    const options = McpPageExportOptionsSchema.parse(target.imageExport);
    const image = this.ports.image;
    if (!image)
      throw new McpEditError(
        "invalid_edit",
        "Raster export is not configured.",
      );
    const result = await this.exportWith(
      target,
      context,
      async (page, signal) => {
        if (options.omitText && !page.inpaintedImagePath)
          throw new McpEditError(
            "invalid_edit",
            "Textless output requires an existing inpainted image. Erasure is not run automatically.",
          );
        return image.render(page, signal, options);
      },
      (bytes, access, source) =>
        image.store(bytes, options.format, access, source),
      retainedAccess,
    );
    return { ...result, kind: "rendered-page-image", imageExport: options };
  }
  private async exportWith<A extends Artifact>(
    target: Target,
    context: McpOperationContext,
    render: Renderer,
    store: Writer<A>,
    retainedAccess?: () => Promise<void>,
  ) {
    const authorize =
      retainedAccess ?? (async () => context.assertAuthorized());
    context.assertAuthorized();
    const page = await this.load(target);
    const source = await this.ports.bindSource?.(page);
    if (
      target.sourceNameFingerprint &&
      target.sourceNameFingerprint !== source?.sourceNameFingerprint
    )
      throw new McpEditError(
        "revision_conflict",
        "Saved source naming changed before rendering.",
      );
    const assertAccess = async () => {
      await authorize();
      await this.ports.assertImageAccess();
      const page = await this.load(target);
      if (createPageRevision(page) !== target.revision)
        throw new McpEditError(
          "revision_conflict",
          "Page changed. Export its current revision instead.",
        );
      await source?.verify(page, target.sourceNameFingerprint);
      await authorize();
    };
    context.assertAuthorized();
    await assertAccess();
    context.progress({ phase: "rendering" });
    const bytes = await render(page, context.signal);
    context.assertAuthorized();
    await assertAccess();
    const artifact = await store(bytes, assertAccess, {
      chapterId: target.chapterId,
      pageId: target.pageId,
      revision: target.revision,
      ...(source ? { sourceFingerprint: source.fingerprint } : {}),
      ...(target.sourceNameFingerprint
        ? { sourceNameFingerprint: target.sourceNameFingerprint }
        : {}),
    });
    context.assertAuthorized();
    context.progress({ phase: "done", completed: 1, total: 1 });
    const publicTarget = { ...target };
    delete publicTarget.sourceNameFingerprint;
    return {
      ...publicTarget,
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
