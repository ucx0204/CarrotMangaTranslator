import type { MangaPage } from "../../shared/libraryTypes";
import type { McpPageReview } from "../../shared/mcpReviewSchemas";
import { createPageRevision } from "../../shared/pageRevision";
import { getActiveGeneratedLettering } from "../../shared/generatedLettering";

/** Existing saved-page concern rules shared by chapter and selected metadata review. */
export function inspectMcpReviewPage(
  page: MangaPage,
  pageIndex: number,
): McpPageReview {
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
