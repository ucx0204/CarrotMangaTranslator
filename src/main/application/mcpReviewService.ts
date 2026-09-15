import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type {
  McpReviewFilter,
  McpPageReview,
} from "../../shared/mcpReviewSchemas";
import type { PageImageExportPreflightResult } from "../../shared/pageImageExportTypes";
import { createPageRevision } from "../../shared/pageRevision";
import { hashStableValue } from "../../shared/blockFingerprint";
import { getActiveGeneratedLettering } from "../../shared/generatedLettering";
import { McpEditError } from "./mcpEditPolicy";

type Ports = {
  openChapter: (chapterId: string) => Promise<ChapterSnapshot>;
  preflight: (
    chapter: ChapterSnapshot,
    pageId: string,
  ) => Promise<PageImageExportPreflightResult>;
};
/** Saved-data inspection only: no model, image decode, mutation, asset download or execution reservation. */
export class McpReviewService {
  constructor(private readonly ports: Ports) {}
  async chapter(
    chapterId: string,
    window: { offset: number; limit: number },
    filter: McpReviewFilter = "all",
    expectedSnapshot?: string,
  ) {
    const chapter = await this.ports.openChapter(chapterId);
    const pages = chapter.pages.map(inspectPage);
    const snapshot = hashStableValue({ chapterId, pages });
    if (expectedSnapshot !== undefined && expectedSnapshot !== snapshot)
      throw new McpEditError(
        "revision_conflict",
        "Chapter review changed. Restart pagination using the new snapshot.",
      );
    const selected = pages.filter((page) => matches(page, filter));
    const next = window.offset + window.limit;
    return {
      chapterId,
      workId: chapter.workId,
      snapshot,
      filter,
      scope: "saved-metadata-only" as const,
      total: selected.length,
      ...window,
      nextOffset: next < selected.length ? next : null,
      summary: summarize(pages),
      pages: selected.slice(window.offset, next),
    };
  }
  async preflight(chapterId: string, pageId: string) {
    const chapter = await this.ports.openChapter(chapterId);
    const page = chapter.pages.find((item) => item.id === pageId);
    if (!page) throw new McpEditError("not_found", "Page not found.");
    const review = inspectPage(page, chapter.pages.indexOf(page));
    const result = await this.ports.preflight(chapter, pageId);
    const latest = (await this.ports.openChapter(chapterId)).pages.find(
      (item) => item.id === pageId,
    );
    if (
      !latest ||
      hashStableValue(inspectPage(latest, review.pageIndex)) !==
        hashStableValue(review)
    )
      throw new McpEditError(
        "revision_conflict",
        "Page changed during inspection. Run preflight again.",
      );
    return {
      chapterId,
      pageId,
      revision: review.revision,
      scope: "saved-metadata-and-app-export-rules" as const,
      counts: review.counts,
      issues: result.issues
        .filter(
          (issue) => issue.chapterId === chapterId && issue.pageId === pageId,
        )
        .map(({ code, severity }) => ({ code, severity })),
      checked: ["saved-page-metadata", "existing-app-export-preflight"],
      notChecked: [
        "image-file-readability",
        "renderer-and-font-assets",
        "live-job-or-unsaved-editor-state",
        "image-transfer-permission-and-redaction",
        "model-readiness",
        "translation-quality",
      ],
      executionReserved: false as const,
    };
  }
}
function inspectPage(page: MangaPage, pageIndex: number): McpPageReview {
  const counts = blockCounts(page);
  const concerns: McpPageReview["concerns"] = [];
  if (!counts.blocks) concerns.push("no-blocks");
  if (counts.untranslated) concerns.push("untranslated");
  if (counts.unreviewed) concerns.push("unreviewed");
  if (
    page.analysisStatus === "failed" ||
    page.translationCompletion?.status === "failed"
  )
    concerns.push("failed");
  if (page.translationCompletion?.status === "pending")
    concerns.push("postprocess-pending");
  if (counts.staleLettering) concerns.push("stale-lettering");
  return {
    pageId: page.id,
    pageIndex,
    revision: createPageRevision(page),
    analysisStatus: page.analysisStatus,
    postprocessStatus: page.translationCompletion?.status ?? null,
    counts,
    references: {
      original: Boolean(page.imagePath),
      cleaned: Boolean(page.inpaintedImagePath),
      mask: Boolean(page.inpaintMaskPath),
    },
    concerns,
  };
}
function blockCounts(page: MangaPage): McpPageReview["counts"] {
  const result = {
    blocks: page.blocks.length,
    untranslated: 0,
    missingSource: 0,
    unreviewed: 0,
    soundEffects: 0,
    excludedFromErasure: 0,
    staleLettering: 0,
  };
  for (const block of page.blocks) {
    result.untranslated += Number(
      Boolean(block.sourceText.trim()) && !block.translatedText.trim(),
    );
    result.missingSource += Number(!block.sourceText.trim());
    result.unreviewed += Number(block.reviewStatus !== "reviewed");
    result.soundEffects += Number(block.textRole === "sound");
    result.excludedFromErasure += Number(block.inpaintExcluded === true);
    const artwork = block.generatedLettering;
    result.staleLettering += Number(
      Boolean(
        artwork &&
        artwork.enabled !== false &&
        !getActiveGeneratedLettering(block),
      ),
    );
  }
  return result;
}
function matches(page: McpPageReview, filter: McpReviewFilter): boolean {
  if (filter === "all") return true;
  if (filter === "attention") return page.concerns.length > 0;
  return page.concerns.includes(filter);
}
function summarize(pages: McpPageReview[]) {
  const count = (flag: McpPageReview["concerns"][number]) =>
    pages.filter((page) => page.concerns.includes(flag)).length;
  return {
    pages: pages.length,
    attention: pages.filter((page) => page.concerns.length > 0).length,
    noBlocks: count("no-blocks"),
    untranslated: count("untranslated"),
    unreviewed: count("unreviewed"),
    failed: count("failed"),
    postprocessPending: count("postprocess-pending"),
    staleLettering: count("stale-lettering"),
  };
}
