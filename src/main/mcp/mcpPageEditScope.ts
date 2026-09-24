import { randomUUID } from "node:crypto";
import type { AppActivityResource } from "../../shared/appActivityTypes";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import { openChapter } from "../library";
import { runMcpAppJob } from "./mcpAppJob";
import { withMcpAuthorization } from "./mcpAuthorizationScope";

type Target = { chapterId: string; pageId: string };

/** Page ownership is the existing native job/handoff contract, not a second lock.
 * Synchronous tools have no background continuation after their caller leaves. */
export function createMcpPageEditScope(
  app: InpaintingJobContext,
  readChapter = openChapter,
  lifetime?: AbortSignal,
  resources: readonly AppActivityResource[] = [],
) {
  return function run<T>(
    target: Target,
    authorize: () => void,
    execute: (assertAuthorized: () => void, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return withMcpAuthorization(
      authorize,
      lifetime,
      (assertAuthorized, signal) =>
        runMcpAppJob(
          app,
          { id: randomUUID(), signal, assertAuthorized, progress: () => {} },
          "mcp-edit",
          async (context) => {
            context.assertAuthorized();
            return execute(context.assertAuthorized, context.signal);
          },
          { resources, page: { ...target, readChapter } },
        ),
    );
  };
}
