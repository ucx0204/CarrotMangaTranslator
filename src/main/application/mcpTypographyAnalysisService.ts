import { hashStableValue } from "../../shared/blockFingerprint";
import { createPageRevision } from "../../shared/pageRevision";
import { mcpContextRevision } from "../../shared/mcpContextEditing";
import type { MangaPage } from "../../shared/libraryTypes";
import {
  McpTypographyAnalysisTargetSchema,
  McpTypographyAnalysisObservationSchema,
  McpTypographyAnalysisPagesSchema,
  type McpTypographyAnalysisTarget,
  type McpTypographyAnalysisObservation,
  type McpTypographyPreparedPage,
} from "../../shared/mcpTypographyAnalysis";
import { McpTypographyReadService } from "./mcpTypographyReadService";
import {
  assertContextTarget,
  type McpContextSnapshot,
} from "./mcpContextEditPolicy";
import type { McpOperationContext } from "./mcpOperationService";
import { mcpBatchMembership, requireBatchPage } from "./mcpPageBatchPolicy";
import { McpEditError } from "./mcpEditPolicy";

type Analysis = Pick<
  McpTypographyAnalysisObservation,
  "pages" | "environmentSnapshot"
>;
type Ports = {
  read: (chapterId: string) => Promise<McpContextSnapshot>;
  preparation: McpTypographyReadService;
  analyze: (
    input: {
      saved: McpContextSnapshot;
      pages: MangaPage[];
      prepared: McpTypographyPreparedPage[];
      request: McpTypographyAnalysisTarget;
    },
    context: McpOperationContext,
  ) => Promise<Analysis>;
};

/** Bounded observations in the existing job journal projection, with NO save port. */
export class McpTypographyAnalysisService {
  constructor(
    private readonly ports: Ports,
    private readonly now = Date.now,
  ) {}

  async run(input: unknown, context: McpOperationContext) {
    const request = McpTypographyAnalysisTargetSchema.parse(input);
    context.assertAuthorized();
    const prepared = await this.prepare(request, context);
    const saved = await this.ports.read(request.chapterId);
    context.assertAuthorized();
    assertContextTarget(saved, request.chapterId, mcpContextRevision(saved));
    const pages = request.pages.map((target) =>
      requireBatchPage(saved.chapter, { ...target, edits: [] }),
    );
    const before = savedIdentity(saved, pages);
    const analysis = await this.ports.analyze(
      {
        saved: structuredClone(saved),
        pages: structuredClone(pages),
        prepared: prepared.pages,
        request,
      },
      context,
    );
    context.assertAuthorized();
    const current = await this.ports.read(request.chapterId);
    context.assertAuthorized();
    assertContextTarget(
      current,
      request.chapterId,
      mcpContextRevision(current),
    );
    const after = request.pages.map((target) =>
      requireBatchPage(current.chapter, { ...target, edits: [] }),
    );
    if (before !== savedIdentity(current, after))
      throw new McpEditError(
        "revision_conflict",
        "Typography source scope or context changed during analysis.",
      );
    const fresh = await this.ports.preparation.preflight(
      preflightRequest(request),
      context.assertAuthorized,
    );
    assertPrepared(request, fresh);
    assertResultInventory(analysis.pages, prepared.pages);
    context.assertAuthorized();
    const observation = McpTypographyAnalysisObservationSchema.parse({
      ...analysis,
      expiresAt: this.now() + 30 * 60_000,
      workId: saved.workId,
      membership: mcpBatchMembership(saved.chapter),
      contextRevision: mcpContextRevision(saved),
      inputSnapshot: request.snapshot,
      catalogSnapshot: request.catalogSnapshot,
      mode: request.mode,
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      preserveManualFontSize: request.preserveManualFontSize,
      notes: [
        "explicit_selected_analysis_scope_not_implicit_whole_chapter",
        "source_face_pixels_are_not_nominal_font_size",
        "font_choices_have_no_calibrated_confidence_score",
        "font_candidates_are_observations_not_approved_style_changes",
        "manual_font_profile_locks_are_not_evaluated_by_observation_tool",
        "source_match_application_is_a_separate_explicit_action",
        "no_translation_erasure_render_export_or_page_write",
        "session_observation_expires_after_30_minutes_or_restart",
      ],
    });
    return {
      kind: "typography-analysis",
      status: "observed",
      chapterId: request.chapterId,
      engine: request.mode === "size" ? "app-source-raster" : "app-c23",
      performed: prepared.requiredStages,
      pagesChanged: 0,
      needsReview: true,
      observationExpired: false,
      typographyAnalysis: observation,
    };
  }

  private async prepare(
    request: McpTypographyAnalysisTarget,
    context: McpOperationContext,
  ) {
    const result = await this.ports.preparation.preflight(
      preflightRequest(request),
      context.assertAuthorized,
    );
    context.assertAuthorized();
    assertPrepared(request, result);
    if (result.status === "blocked")
      throw new McpEditError(
        "invalid_edit",
        `Typography analysis blocked: ${result.blockers.join(", ")}.`,
      );
    if (result.requiresOcr && !request.allowAssetDownloads)
      throw new McpEditError(
        "invalid_edit",
        "C23 uses app-managed Hayai and font assets. Explicit allowAssetDownloads=true is required; nothing was started. Installed-only C23 execution is not exposed yet.",
      );
    return result;
  }
}

function preflightRequest(request: McpTypographyAnalysisTarget) {
  const {
    pages,
    snapshot: _snapshot,
    catalogSnapshot: _catalog,
    requestId: _request,
    allowAssetDownloads: _downloads,
    ...options
  } = request;
  return { ...options, pageIds: pages.map((page) => page.pageId) };
}
function assertPrepared(
  request: McpTypographyAnalysisTarget,
  current: Awaited<ReturnType<McpTypographyReadService["preflight"]>>,
) {
  const targets = current.pages.map(({ pageId, revision }) => ({
    pageId,
    revision,
  }));
  if (
    current.snapshot !== request.snapshot ||
    current.catalogSnapshot !== request.catalogSnapshot ||
    hashStableValue(targets) !== hashStableValue(request.pages)
  )
    throw new McpEditError(
      "revision_conflict",
      "Preflight inputs, font catalog or ordered page revisions changed. Prepare a new explicit analysis.",
    );
}
function savedIdentity(saved: McpContextSnapshot, pages: MangaPage[]) {
  return hashStableValue({
    workId: saved.workId,
    membership: mcpBatchMembership(saved.chapter),
    context: mcpContextRevision(saved),
    pages: pages.map((page) => [page.id, createPageRevision(page)]),
  });
}
function assertResultInventory(
  value: Analysis["pages"],
  prepared: McpTypographyPreparedPage[],
) {
  const pages = McpTypographyAnalysisPagesSchema.parse(value);
  const actual = pages.map((page) => [
    page.pageId,
    page.revision,
    page.items.map((item) => item.blockId),
  ]);
  const expected = prepared.map((page) => [
    page.pageId,
    page.revision,
    page.blocks.map((block) => block.blockId),
  ]);
  if (hashStableValue(actual) !== hashStableValue(expected))
    throw new McpEditError(
      "invalid_edit",
      "Typography analysis returned a mismatched page/block inventory.",
    );
  for (const [index, page] of pages.entries()) {
    for (const [blockIndex, item] of page.items.entries()) {
      const eligibility = prepared[index].blocks[blockIndex];
      if (
        !consistentEvidence(
          eligibility.fontEligible,
          item.font,
          item.fontExclusion,
          eligibility.fontExclusion,
        ) ||
        !consistentEvidence(
          eligibility.sizeEligible,
          item.estimate,
          item.sizeExclusion,
          eligibility.sizeExclusion,
        )
      )
        throw new McpEditError(
          "invalid_edit",
          "Typography evidence contradicts the inspected eligibility or exclusions.",
        );
    }
  }
}

function consistentEvidence(
  eligible: boolean,
  evidence: object | null,
  reason: string | null,
  expectedExclusion: string | null,
) {
  if (!eligible) return evidence === null && reason === expectedExclusion;
  return evidence === null ? Boolean(reason) : reason === null;
}
