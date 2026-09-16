import { randomUUID } from "node:crypto";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import { openChapter } from "../library";
import { runMcpAppJob } from "./mcpAppJob";

type Target = { chapterId: string; pageId: string };

/** Page ownership is the existing native job/handoff contract, not a second lock.
 * Synchronous tools have no background continuation after their caller leaves. */
export function createMcpPageEditScope(
  app: InpaintingJobContext,
  readChapter = openChapter,
) {
  return async function run<T>(
    target: Target,
    authorize: () => void,
    execute: (assertAuthorized: () => void) => Promise<T>,
  ): Promise<T> {
    authorize();
    const controller = new AbortController();
    const monitor = setInterval(() => {
      try {
        authorize();
      } catch (error) {
        controller.abort(error);
      }
    }, 250);
    monitor.unref();
    try {
      return await runMcpAppJob(
        app,
        {
          id: randomUUID(),
          signal: controller.signal,
          assertAuthorized: authorize,
          progress: () => {},
        },
        "mcp-edit",
        async (context) => {
          context.assertAuthorized();
          return execute(context.assertAuthorized);
        },
        { resources: [], page: { ...target, readChapter } },
      );
    } finally {
      clearInterval(monitor);
    }
  };
}
