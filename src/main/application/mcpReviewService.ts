import type { ChapterSnapshot } from "../../shared/libraryTypes";
import type {
  McpReviewFilter,
  McpPageReview,
} from "../../shared/mcpReviewSchemas";
import type { PageImageExportPreflightResult } from "../../shared/pageImageExportTypes";
import { hashStableValue } from "../../shared/blockFingerprint";
import { McpEditError } from "./mcpEditPolicy";
import { inspectMcpReviewPage } from "./mcpReviewPage";

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
    const pages = chapter.pages.map(inspectMcpReviewPage);
    const snapshot = hashStableValue({
      chapterId,
      workId: chapter.workId,
      pages,
    });
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
    const review = inspectMcpReviewPage(page, chapter.pages.indexOf(page));
    const result = await this.ports.preflight(chapter, pageId);
    const latestChapter = await this.ports.openChapter(chapterId);
    const latestIndex = latestChapter.pages.findIndex(
      (item) => item.id === pageId,
    );
    const latest = latestChapter.pages[latestIndex];
    if (
      !latest ||
      latestChapter.workId !== chapter.workId ||
      hashStableValue(inspectMcpReviewPage(latest, latestIndex)) !==
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
