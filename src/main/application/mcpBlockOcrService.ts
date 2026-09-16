import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type { PixelRect } from "../../shared/region";
import { bboxToPixels } from "../../shared/geometry";
import { createPageRevision } from "../../shared/pageRevision";
import {
  McpBlockOcrObservationSchema,
  type McpBlockOcrObservation,
  type McpBlockOcrTarget,
} from "../../shared/mcpBlockOcr";
import { McpSourceRectPatchSchema } from "../../shared/mcpSourceRect";
import { McpEditError } from "./mcpEditPolicy";
import type { McpOperationContext } from "./mcpOperationService";

type Evidence = Pick<
  McpBlockOcrObservation,
  "recognizedText" | "regions" | "sourceLanguage" | "sourceCropSha256"
> & { engine: string };

type Ports = {
  openChapter: (chapterId: string) => Promise<ChapterSnapshot>;
  recognize: (
    page: MangaPage,
    cropRect: PixelRect,
    context: McpOperationContext,
  ) => Promise<Evidence>;
};

/** No persistence/mutation port is available. The caller owns the existing app
 * page/model lease through recognition AND actual runtime cleanup. */
export class McpBlockOcrService {
  constructor(private readonly ports: Ports) {}

  async run(target: McpBlockOcrTarget, context: McpOperationContext) {
    context.assertAuthorized();
    const page = await this.load(target);
    const selected = selectMcpBlockOcr(page, target.blockId);
    context.assertAuthorized();
    context.progress({ phase: "ocr_preparing" });
    const evidence = await this.ports.recognize(
      page,
      selected.cropRect,
      context,
    );
    context.assertAuthorized();
    await this.load(target);
    context.assertAuthorized();
    const noTextDetected = !evidence.recognizedText.trim();
    const parsed = McpBlockOcrObservationSchema.safeParse({
      ...selected,
      ...evidence,
      engine: undefined,
      differs: selected.previousSourceText !== evidence.recognizedText,
      readingOrder: "app-crop-heuristic",
      warnings: [
        "review_before_apply",
        "source_evidence_retained",
        ...(evidence.regions.length > 1 ? ["multiple_regions"] : []),
        ...(noTextDetected ? ["no_text_keep_existing"] : []),
      ],
    });
    if (!parsed.success)
      throw new McpEditError(
        "invalid_edit",
        "OCR returned invalid or excessive text evidence. Nothing was saved.",
      );
    return {
      chapterId: target.chapterId,
      pageId: target.pageId,
      blockId: target.blockId,
      revision: target.revision,
      status: "observed",
      engine: evidence.engine,
      performed: ["block-ocr"],
      pagesChanged: 0,
      noTextDetected,
      needsReview: true,
      observationExpired: false,
      blockOcr: parsed.data,
    };
  }

  private async load(target: McpBlockOcrTarget): Promise<MangaPage> {
    const chapter = await this.ports.openChapter(target.chapterId);
    const page = chapter.pages.find((item) => item.id === target.pageId);
    if (chapter.id !== target.chapterId || !page)
      throw new McpEditError("not_found", "Page not found.");
    if (createPageRevision(page) !== target.revision)
      throw new McpEditError(
        "revision_conflict",
        "Page changed. Read the page again before requesting or applying block OCR.",
      );
    return structuredClone(page);
  }
}

/** Exact saved source geometry, with only the containing pixel crop rounded.
 * Do not use the page-translation crop helper: it adds minimum-size padding. */
export function selectMcpBlockOcr(page: MangaPage, blockId: string) {
  const matches = page.blocks.filter((item) => item.id === blockId);
  if (matches.length !== 1)
    throw new McpEditError(
      matches.length ? "invalid_edit" : "not_found",
      "A unique existing source block is required.",
    );
  const block = matches[0];
  if (typeof block.sourceText !== "string" || block.sourceText.length > 20_000)
    throw new McpEditError(
      "invalid_edit",
      "Existing source text exceeds the observation limit.",
    );
  const raw =
    block.bboxSpace === "pixels"
      ? block.bbox
      : bboxToPixels(block.bbox, page.width, page.height);
  const parsed = McpSourceRectPatchSchema.shape.sourceRect.safeParse(raw);
  if (
    !parsed.success ||
    !Number.isSafeInteger(page.width) ||
    !Number.isSafeInteger(page.height) ||
    page.width <= 0 ||
    page.height <= 0
  )
    throw new McpEditError(
      "invalid_edit",
      "Invalid source rectangle or image dimensions.",
    );
  const sourceRect = parsed.data;
  if (
    sourceRect.x + sourceRect.w > page.width ||
    sourceRect.y + sourceRect.h > page.height
  )
    throw new McpEditError(
      "invalid_edit",
      "Source rectangle must be inside the original image.",
    );
  const x = Math.floor(sourceRect.x);
  const y = Math.floor(sourceRect.y);
  const cropRect = {
    x,
    y,
    w: Math.ceil(sourceRect.x + sourceRect.w) - x,
    h: Math.ceil(sourceRect.y + sourceRect.h) - y,
  };
  return { sourceRect, cropRect, previousSourceText: block.sourceText };
}
