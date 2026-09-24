import type { ChapterSnapshot } from "../../shared/libraryTypes";
import { createSoundEffectReviewPageRevision } from "../../shared/pageRevision";
import type {
  McpCompositeGuard,
  McpCompositeRecord,
} from "./mcpCompositeWorkflowPorts";
import { compositeFingerprint } from "./mcpCompositeWorkflowPolicy";
import { parseCompositeRecord } from "./mcpCompositeWorkflowRecord";
import { McpEditError } from "./mcpEditPolicy";
import { inspectMcpReviewPage } from "./mcpReviewPage";

type Window = { offset: number; limit: number; snapshot?: string };
type Ports = {
  openChapter: (chapterId: string) => Promise<ChapterSnapshot>;
  /** Compare the exact current parent source/policy binding; never replace it. */
  verifySources: (
    record: McpCompositeRecord,
    guard: McpCompositeGuard,
  ) => Promise<void>;
};

/** Selected saved metadata only. The caller loads the owned, unexpired parent.
 * Block restrictions authorize edits; counts explicitly inspect whole selected pages. */
export async function inspectMcpCompositeMetadata(
  input: McpCompositeRecord,
  window: Window,
  guard: McpCompositeGuard,
  ports: Ports,
) {
  guard();
  const record = parseCompositeRecord(input);
  assertWindow(window);
  await ports.verifySources(record, guard);
  const pages = await readSelected(record, guard, ports);
  const snapshot = compositeFingerprint({
    id: record.id,
    version: record.version,
    parentSnapshot: record.snapshot.fingerprint,
    pages,
  });
  if (window.snapshot !== undefined && window.snapshot !== snapshot)
    throw changed();
  await ports.verifySources(record, guard);
  const latest = await readSelected(record, guard, ports);
  if (compositeFingerprint(pages) !== compositeFingerprint(latest))
    throw changed();
  guard();
  const next = window.offset + window.limit;
  return {
    id: record.id,
    version: record.version,
    snapshot,
    scope: "selected-saved-metadata-only" as const,
    total: pages.length,
    offset: window.offset,
    limit: window.limit,
    nextOffset: next < pages.length ? next : null,
    pages: pages.slice(window.offset, next),
    checked: ["saved-page-metadata", "current-parent-source-binding"],
    notChecked: [
      "existing-app-export-preflight",
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

async function readSelected(
  record: McpCompositeRecord,
  guard: McpCompositeGuard,
  ports: Ports,
) {
  const chapters = new Map<string, ChapterSnapshot>();
  const reviews = [];
  for (const [index, target] of record.targets.entries()) {
    guard();
    let chapter = chapters.get(target.chapterId);
    if (!chapter) {
      chapter = await ports.openChapter(target.chapterId);
      chapters.set(target.chapterId, chapter);
    }
    const pageIndex = chapter.pages.findIndex(
      (page) => page.id === target.pageId,
    );
    const page = chapter.pages[pageIndex];
    if (
      !page ||
      chapter.id !== target.chapterId ||
      chapter.workId !== target.workId
    )
      throw changed();
    const review = inspectMcpReviewPage(page, pageIndex);
    const expected = record.snapshot.pages[index];
    if (
      !expected ||
      review.revision !== expected.revision ||
      createSoundEffectReviewPageRevision(page) !== expected.reviewRevision
    )
      throw changed();
    reviews.push({
      workId: target.workId,
      chapterId: target.chapterId,
      blockScope: "whole-page-saved-metadata" as const,
      review,
    });
  }
  guard();
  return reviews;
}
function assertWindow(window: Window) {
  if (
    !Number.isSafeInteger(window.offset) ||
    window.offset < 0 ||
    !Number.isSafeInteger(window.limit) ||
    window.limit < 1 ||
    window.limit > 25 ||
    (window.snapshot !== undefined &&
      !/^[a-f0-9]{64}$/.test(window.snapshot)) ||
    (window.offset > 0 && window.snapshot === undefined)
  )
    throw new McpEditError(
      "invalid_edit",
      "Use 1–25 pages and the previous snapshot after offset zero.",
    );
}
function changed() {
  return new McpEditError(
    "revision_conflict",
    "Selected parent metadata or source binding changed. Inspect the parent again before restarting pagination.",
  );
}
