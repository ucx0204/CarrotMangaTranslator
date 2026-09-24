import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import { createPageRevision } from "../../shared/pageRevision";
import {
  McpSourceSizeTargetSchema,
  McpSourceSizeObservationSchema,
  type McpSourceSizeTarget,
  type McpSourceSizeObservation,
} from "../../shared/mcpSourceSize";
import { mcpBatchMembership } from "./mcpPageBatchPolicy";
import { selectMcpBlockOcr } from "./mcpBlockOcrService";
import { McpEditError } from "./mcpEditPolicy";
import type { McpOperationContext } from "./mcpOperationService";

type Item = McpSourceSizeObservation["items"][number];
type Ports = {
  openChapter: (id: string) => Promise<ChapterSnapshot>;
  measure: (
    page: MangaPage,
    blocks: TranslationBlock[],
    context: McpOperationContext,
  ) => Promise<{
    sourceImageSha256: string;
    estimates: Array<Item["estimate"]>;
  }>;
};

/** No save port: observations cannot modify the page or its typography intent. */
export class McpSourceSizeService {
  constructor(
    private readonly ports: Ports,
    private readonly now = Date.now,
  ) {}

  async run(input: McpSourceSizeTarget, context: McpOperationContext) {
    const target = McpSourceSizeTargetSchema.parse(input);
    context.assertAuthorized();
    const before = await this.load(target);
    context.assertAuthorized();
    const prepared = prepare(before.page);
    if (!prepared.eligible.length)
      throw new McpEditError(
        "invalid_edit",
        "No eligible ordinary source blocks; nothing was measured or saved.",
      );
    context.progress({
      phase: "source_size_measurement",
      completed: 0,
      total: prepared.eligible.length,
    });
    const measured = await this.ports.measure(
      before.page,
      prepared.eligible,
      context,
    );
    context.assertAuthorized();
    if (measured.estimates.length !== prepared.eligible.length)
      throw new McpEditError(
        "invalid_edit",
        "Source measurement failed or returned an inconsistent inventory.",
      );
    const after = await this.load(target);
    context.assertAuthorized();
    if (after.membership !== before.membership)
      throw new McpEditError(
        "revision_conflict",
        "Chapter membership or order changed during source measurement.",
      );
    let index = 0;
    const items = prepared.items.map((item): Item => {
      if (item.excludedReason) return item;
      const estimate = measured.estimates[index++] ?? null;
      return {
        ...item,
        estimate,
        excludedReason: estimate ? null : "insufficient_raster_evidence",
      };
    });
    const observation = McpSourceSizeObservationSchema.parse({
      sourceImageSha256: measured.sourceImageSha256,
      expiresAt: this.now() + 30 * 60_000,
      measuredBlocks: items.filter((item) => item.estimate !== null).length,
      items,
      notes: [
        "source_face_pixels_are_not_nominal_font_size",
        "manual_size_and_generated_lettering_preserved",
        "no_ocr_model_translation_erasure_render_or_page_write",
        "application_is_not_implemented_by_this_tool",
      ],
    });
    context.progress({
      phase: "source_size_observed",
      completed: prepared.eligible.length,
      total: prepared.eligible.length,
    });
    return {
      chapterId: target.chapterId,
      pageId: target.pageId,
      revision: target.revision,
      kind: "source-size-observation",
      engine: "app-source-raster",
      status: "observed",
      performed: ["source_size_measurement"],
      pagesChanged: 0,
      needsReview: true,
      observationExpired: false,
      sourceSize: observation,
    };
  }

  private async load(target: McpSourceSizeTarget) {
    const chapter = await this.ports.openChapter(target.chapterId);
    const pages = chapter.pages.filter((page) => page.id === target.pageId);
    if (chapter.id !== target.chapterId || pages.length !== 1)
      throw new McpEditError("not_found", "A unique saved page is required.");
    const page = pages[0];
    if (createPageRevision(page) !== target.revision)
      throw new McpEditError(
        "revision_conflict",
        "Page changed. Read it again before source measurement.",
      );
    return {
      page: structuredClone(page),
      membership: mcpBatchMembership(chapter),
    };
  }
}

function prepare(page: MangaPage) {
  if (
    page.blocks.length > 1000 ||
    new Set(page.blocks.map((block) => block.id)).size !== page.blocks.length
  )
    throw new McpEditError(
      "invalid_edit",
      "At most 1000 distinct saved blocks may be inspected.",
    );
  const eligible: TranslationBlock[] = [];
  const items = page.blocks.map((block): Item => {
    const excludedReason = exclusion(block);
    if (!excludedReason) {
      selectMcpBlockOcr(page, block.id); // Geometry validation only; never performs OCR.
      if (!["horizontal", "vertical"].includes(block.sourceDirection))
        throw new McpEditError(
          "invalid_edit",
          "Source direction is missing or invalid.",
        );
      eligible.push(block);
    }
    return { blockId: block.id, estimate: null, excludedReason };
  });
  return { eligible, items };
}

function exclusion(block: TranslationBlock): Item["excludedReason"] {
  if (block.generatedLettering) return "generated_lettering";
  if (!block.sourceText.trim()) return "empty_source";
  if (block.textRole === "sound" || block.fontRole?.startsWith("sfx_"))
    return "sound_effect_out_of_scope";
  if (block.fontSizeIntent === "manual") return "manual_font_size_preserved";
  return null;
}
