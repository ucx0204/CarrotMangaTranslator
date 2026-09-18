import { hashStableValue } from "../../shared/blockFingerprint";
import { createPageRevision } from "../../shared/pageRevision";
import {
  isJapaneseLanguageCode,
  isKoreanLanguageCode,
} from "../../shared/translationLanguages";
import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import {
  McpFontListInput,
  McpFontListOutput,
  McpTypographyPreflightInput,
  McpTypographyPreflightOutput,
  type McpFontEntry,
  type McpTypographyPreflight,
} from "../../shared/mcpTypographyRead";
import { McpEditError } from "./mcpEditPolicy";
import { mcpBatchMembership } from "./mcpPageBatchPolicy";

export type McpFontCatalog = { snapshot: string; fonts: McpFontEntry[] };
type Ports = {
  openChapter: (id: string) => Promise<ChapterSnapshot>;
  readCatalog: () => Promise<McpFontCatalog>;
  analysisToolAvailable?: boolean;
};

/** Read-only preparation. A saved input inventory is not an execution reservation. */
export class McpTypographyReadService {
  constructor(private readonly ports: Ports) {}

  async listFonts(input: unknown, guard: () => void) {
    const request = McpFontListInput.parse(input);
    guard();
    const catalog = await this.ports.readCatalog();
    guard();
    if (request.snapshot && request.snapshot !== catalog.snapshot)
      throw new McpEditError(
        "revision_conflict",
        "Font inventory changed. Restart pagination.",
      );
    const query = request.query?.toLocaleLowerCase() ?? "";
    const fonts = catalog.fonts.filter(
      (font) =>
        (request.includeHidden || !font.hidden) &&
        (!request.locale || font.locales.includes(request.locale)) &&
        (!query ||
          `${font.fontId} ${font.label}`.toLocaleLowerCase().includes(query)),
    );
    return McpFontListOutput.parse({
      snapshot: catalog.snapshot,
      total: fonts.length,
      offset: request.offset,
      limit: request.limit,
      nextOffset:
        request.offset + request.limit < fonts.length
          ? request.offset + request.limit
          : null,
      fonts: fonts.slice(request.offset, request.offset + request.limit),
      notes: [
        "app_registered_fonts_only_not_os_font_inventory",
        "availability_is_file_and_catalog_inspection_not_renderer_or_per_text_glyph_validation",
        "base_face_metrics_only_not_all_supported_weights_or_synthetic_styles",
        "snapshot_binds_catalog_metadata_not_model_or_font_file_bytes",
        "custom_font_records_with_missing_or_unsafe_files_are_omitted_by_app_registry",
      ],
    });
  }

  async preflight(input: unknown, guard: () => void) {
    const request = McpTypographyPreflightInput.parse(input);
    guard();
    const chapter = await this.ports.openChapter(request.chapterId);
    guard();
    const pages = selectPages(chapter, request);
    const catalog = await this.ports.readCatalog();
    guard();
    const current = await this.ports.openChapter(request.chapterId);
    guard();
    if (
      inventory(chapter, pages) !==
      inventory(current, selectPages(current, request))
    )
      throw new McpEditError(
        "revision_conflict",
        "Chapter changed during typography preflight.",
      );
    return projectPreflight(
      chapter,
      pages,
      request,
      catalog,
      Boolean(this.ports.analysisToolAvailable),
    );
  }
}

function selectPages(
  chapter: ChapterSnapshot,
  request: McpTypographyPreflight,
) {
  if (chapter.id !== request.chapterId)
    throw new McpEditError("not_found", "Chapter not found.");
  if (
    new Set(chapter.pages.map((page) => page.id)).size !== chapter.pages.length
  )
    throw new McpEditError(
      "invalid_edit",
      "Stored chapter page IDs are not unique.",
    );
  const selected = new Set(
    request.pageIds ?? chapter.pages.map((page) => page.id),
  );
  if (
    selected.size === 0 ||
    selected.size > 50 ||
    (request.pageIds && selected.size !== request.pageIds.length)
  )
    throw new McpEditError(
      "invalid_edit",
      "Select 1-50 distinct pages; the chapter is never truncated.",
    );
  const pages = chapter.pages.filter((page) => selected.has(page.id));
  if (pages.length !== selected.size)
    throw new McpEditError("not_found", "A selected page is absent.");
  if (
    pages.some(
      (page) =>
        new Set(page.blocks.map((block) => block.id)).size !==
        page.blocks.length,
    )
  )
    throw new McpEditError(
      "invalid_edit",
      "Stored page block IDs are not unique.",
    );
  if (pages.reduce((total, page) => total + page.blocks.length, 0) > 1000)
    throw new McpEditError(
      "invalid_edit",
      "Typography preparation is limited to 1000 blocks.",
    );
  return pages;
}

function inventory(chapter: ChapterSnapshot, pages: readonly MangaPage[]) {
  return hashStableValue({
    membership: mcpBatchMembership(chapter),
    pages: pages.map((page) => [page.id, createPageRevision(page)]),
  });
}

function hasSourceMeasurement(block: TranslationBlock): boolean {
  return (
    Number.isFinite(block.sourceFontFacePx) && (block.sourceFontFacePx ?? 0) > 0
  );
}

function projectBlock(
  block: TranslationBlock,
  request: McpTypographyPreflight,
) {
  const common = block.generatedLettering
    ? "generated_lettering"
    : !block.sourceText.trim()
      ? "empty_source"
      : block.textRole === "sound" || block.fontRole?.startsWith("sfx_")
        ? "sound_effect_out_of_scope"
        : null;
  const fontExclusion = request.mode === "size" ? "not_requested" : common;
  const sizeExclusion =
    request.mode === "font"
      ? "not_requested"
      : (common ??
        (request.preserveManualFontSize && block.fontSizeIntent === "manual"
          ? "manual_font_size_preserved"
          : null));
  return {
    blockId: block.id,
    fontEligible: fontExclusion === null,
    sizeEligible: sizeExclusion === null,
    fontExclusion,
    sizeExclusion,
    manualFontSize: block.fontSizeIntent === "manual",
    hasStoredSourceMeasurement: hasSourceMeasurement(block),
  };
}

function projectPreflight(
  chapter: ChapterSnapshot,
  pages: MangaPage[],
  request: McpTypographyPreflight,
  catalog: McpFontCatalog,
  analysisToolAvailable: boolean,
) {
  const selected = pages.map((page) => ({
    pageId: page.id,
    revision: createPageRevision(page),
    pageIndex: chapter.pages.findIndex((candidate) => candidate.id === page.id),
    blocks: page.blocks.map((block) => projectBlock(block, request)),
  }));
  const blocks = selected.flatMap((page) => page.blocks);
  const wantsFont = request.mode !== "size";
  const fontEligible = blocks.filter((block) => block.fontEligible).length;
  const sizeEligible = blocks.filter((block) => block.sizeEligible).length;
  const requiresOcr = wantsFont && fontEligible > 0;
  const blockers: string[] = [];
  if (requiresOcr && !request.allowOcr)
    blockers.push("font_analysis_requires_explicit_ocr_permission");
  if (
    wantsFont &&
    !(
      isJapaneseLanguageCode(request.sourceLanguage) &&
      isKoreanLanguageCode(request.targetLanguage)
    )
  )
    blockers.push("c23_font_analysis_supports_ja_to_ko_only");
  if (fontEligible + sizeEligible === 0) blockers.push("no_eligible_blocks");
  return McpTypographyPreflightOutput.parse({
    chapterId: chapter.id,
    snapshot: hashStableValue({
      request: { ...request, pageIds: pages.map((page) => page.id) },
      inventory: inventory(chapter, pages),
      catalog: catalog.snapshot,
    }),
    catalogSnapshot: catalog.snapshot,
    mode: request.mode,
    sourceLanguage: request.sourceLanguage,
    targetLanguage: request.targetLanguage,
    status: blockers.length ? "blocked" : "inputs_available",
    blockers,
    requiredStages: requiresOcr
      ? [
          "source_size_measurement",
          "hayai_source_verification",
          "c23_font_selection",
        ]
      : sizeEligible > 0
        ? ["source_size_measurement"]
        : [],
    requiresOcr,
    executionReserved: false,
    analysisToolAvailable,
    pages: selected,
    counts: {
      pages: pages.length,
      blocks: blocks.length,
      fontEligible,
      sizeEligible,
    },
    notChecked: [
      "image_file_readiness",
      "model_assets_and_downloads",
      "model_runtime_availability",
      "live_editor_and_job_locks",
      "font_profile_manual_locks",
      "source_geometry_and_evidence_validity",
      "renderer_and_per_text_glyph_coverage",
    ],
    notes: [
      "no_ocr_translation_erasure_render_export_or_page_write",
      "analysis_scope_is_explicit_selected_pages_not_implicit_whole_chapter",
      "stored_measurement_presence_is_not_proof_of_fresh_evidence",
      "applying_font_or_size_is_separate_from_analysis",
      "inputs_available_is_not_execution_ready",
    ],
  });
}
