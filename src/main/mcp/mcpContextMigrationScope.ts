import { randomUUID } from "node:crypto";
import type { McpContextReferenceSnapshot } from "../../shared/mcpContextReferences";
import type { ContextMigrationDelta } from "../../shared/mcpContextMigrationState";
import { libraryStructureResource } from "../../shared/appActivityTypes";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import { reserveJobChapter, acquireJobPage } from "../jobs/jobPageOwnership";
import { openChapter } from "../library";
import { logError } from "../logger";
import { withMcpAuthorization } from "./mcpAuthorizationScope";
import { runMcpAppJob } from "./mcpAppJob";

type Editing = {
  assertWritable: (chapterId: string, pageId: string) => Promise<void>;
  notifySaved: (chapterId: string, pageId: string) => void;
};
type Receipt = { historical: boolean; status: string; warnings: string[] };

/** Reuse native context/structure exclusion and each affected page's editor handoff. */
export function runContextMigration<T extends Receipt>(options: {
  app: InpaintingJobContext;
  editing: Editing;
  lifetime: AbortSignal;
  graph: McpContextReferenceSnapshot;
  delta: ContextMigrationDelta;
  guard: () => void;
  run: (guard: () => void) => Promise<T>;
}): Promise<T> {
  const { app, editing, lifetime, graph, delta, guard, run } = options;
  return withMcpAuthorization(guard, lifetime, async (check, signal) => {
    const operation = {
      id: randomUUID(),
      signal,
      assertAuthorized: check,
      progress: () => {},
    };
    return runMcpAppJob(
      app,
      operation,
      "mcp-edit",
      async (context) => {
        await acquireMigrationPages(
          app,
          context.id,
          graph,
          delta,
          editing,
          context.assertAuthorized,
        );
        const result = await run(context.assertAuthorized);
        if (!result.historical && result.status === "saved") {
          try {
            for (const page of delta.pages)
              editing.notifySaved(page.chapterId, page.pageId);
          } catch (error) {
            // error-policy-allow: publication committed; retain the durable receipt and report only notification failure.
            result.warnings.push("notification_failed_after_commit");
            logError(
              "Context migration saved; renderer notification failed",
              error,
            );
          }
        }
        return result;
      },
      {
        resources: [
          { kind: "work-context", scope: graph.workId, access: "write" },
          libraryStructureResource("work", graph.workId, "read"),
          ...graph.chapters.map(({ chapter }) =>
            libraryStructureResource("chapter", chapter.id, "read"),
          ),
        ],
      },
    );
  });
}

async function acquireMigrationPages(
  app: InpaintingJobContext,
  jobId: string,
  graph: McpContextReferenceSnapshot,
  delta: ContextMigrationDelta,
  editing: Editing,
  guard: () => void,
) {
  for (const { chapter } of graph.chapters) {
    const pageIds = delta.pages
      .filter((page) => page.chapterId === chapter.id)
      .map((page) => page.pageId);
    if (!pageIds.length) continue;
    reserveJobChapter(app.jobs, jobId, chapter, pageIds);
    for (const pageId of pageIds) {
      guard();
      await acquireJobPage(app.jobs, jobId, chapter.id, pageId, openChapter);
      await editing.assertWritable(chapter.id, pageId);
    }
  }
  guard();
}
