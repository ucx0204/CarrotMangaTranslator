import { hashStableValue } from "../../shared/blockFingerprint";
import type { McpOutputSyncPreflight } from "../../shared/mcpOutputSync";
import type { McpOperationContext } from "../application/mcpOperationService";
import { McpEditError } from "../application/mcpEditPolicy";
import { openChapter } from "../library";
import { reserveJobChapter, acquireJobPage } from "../jobs/jobPageOwnership";
import type { McpOutputSyncOptions } from "./mcpOutputSyncTypes";

/** All mirror pages join the existing chapter/page handoff before native publication. */
export async function ownMcpOutputSyncPages(
  options: McpOutputSyncOptions,
  review: McpOutputSyncPreflight,
  job: McpOperationContext,
) {
  for (const scope of review.mirrorScope.chapters) {
    job.assertAuthorized();
    const chapter = await openChapter(scope.chapterId);
    job.assertAuthorized();
    if (
      chapter.id !== scope.chapterId ||
      hashStableValue(chapter.pageOrder) !== hashStableValue(scope.pageIds)
    )
      throw new McpEditError(
        "revision_conflict",
        "The reviewed shared output scope changed.",
      );
    reserveJobChapter(options.app.jobs, job.id, chapter, scope.pageIds);
  }
  for (const scope of review.mirrorScope.chapters) {
    for (const pageId of scope.pageIds) {
      job.assertAuthorized();
      await acquireJobPage(
        options.app.jobs,
        job.id,
        scope.chapterId,
        pageId,
        openChapter,
      );
      job.assertAuthorized();
      await options.editing.assertClean(scope.chapterId, pageId);
      job.assertAuthorized();
    }
  }
}
