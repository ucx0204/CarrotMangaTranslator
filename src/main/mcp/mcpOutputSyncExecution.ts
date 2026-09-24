import type {
  McpSyncOutput,
  McpOutputSyncPreflight,
} from "../../shared/mcpOutputSync";
import type { McpOutputSyncJobResult } from "../../shared/mcpOutputSyncJob";
import { mcpOutputSyncJobResult } from "../application/mcpOutputSyncJobPolicy";
import type { McpOperationContext } from "../application/mcpOperationService";
import { McpEditError } from "../application/mcpEditPolicy";
import { isAbortErrorLike } from "../abortSignal";
import {
  ReviewedOutputError,
  type ReviewedOutputExecution,
} from "../linkedWorkspace/linkedWorkspaceReviewedOutputTypes";
import { runMcpAppJob } from "./mcpAppJob";
import { withMcpAuthorization } from "./mcpAuthorizationScope";
import type { McpOutputSyncSession } from "./mcpOutputSyncRepository";
import type { McpOutputSyncOptions } from "./mcpOutputSyncTypes";
import { assertOutputSyncImages } from "./mcpOutputSyncAuthority";
import { ownMcpOutputSyncPages } from "./mcpOutputSyncOwnership";

export async function executeMcpOutputSync(
  options: McpOutputSyncOptions,
  owner: string,
  input: McpSyncOutput,
  review: McpOutputSyncPreflight,
  operation: McpOperationContext,
  lifetime: AbortSignal,
): Promise<McpOutputSyncJobResult> {
  return withMcpAuthorization(
    operation.assertAuthorized,
    lifetime,
    async (guard, signal) => {
      await assertOutputSyncImages(options.preferences.allowImages, guard);
      const admitted = await options.repository.begin(
        owner,
        { request: input, jobId: operation.id },
        review,
        guard,
      );
      if (!admitted.session)
        throw new McpEditError(
          "invalid_edit",
          "Output sync already has an original retained job. Inspect that receipt; it cannot be executed by a new job.",
        );
      const session = admitted.session;
      const context = {
        ...operation,
        signal: AbortSignal.any([operation.signal, signal]),
        assertAuthorized: guard,
      };
      let activeContext: McpOperationContext = context;
      try {
        return await runMcpAppJob(
          options.app,
          context,
          "page-export",
          async (job) => {
            activeContext = job;
            await ownMcpOutputSyncPages(options, review, job);
            if (!options.port)
              throw new ReviewedOutputError("destination_unavailable");
            const native = await options.port.execute(
              input,
              publicationContext(options, job, session),
            );
            const receipt = await session.finish(native);
            return mcpOutputSyncJobResult({ input, receipt, jobId: job.id });
          },
          {
            resources: [],
            completionStatus: (result) =>
              result.status === "completed"
                ? "completed"
                : result.status === "cancelled"
                  ? "cancelled"
                  : "failed",
          },
        );
      } catch (error) {
        return failExecution(options, session, input, activeContext, error);
      }
    },
  );
}

function publicationContext(
  options: McpOutputSyncOptions,
  job: McpOperationContext,
  session: McpOutputSyncSession,
): ReviewedOutputExecution {
  const settlements = new Map<
    string,
    Awaited<ReturnType<McpOutputSyncSession["recordIntent"]>>
  >();
  const admitted = new Set<string>();
  return {
    signal: job.signal,
    assertAuthorized: job.assertAuthorized,
    onIntent: async (intent) => {
      await assertOutputSyncImages(
        options.preferences.allowImages,
        job.assertAuthorized,
      );
      if (admitted.has(intent.fileId))
        throw new Error("Duplicate native output intent.");
      const settlement = await session.recordIntent(
        intent,
        job.assertAuthorized,
      );
      admitted.add(intent.fileId);
      settlements.set(intent.fileId, settlement);
      await assertOutputSyncImages(
        options.preferences.allowImages,
        job.assertAuthorized,
      );
    },
    onEffect: async (effect) => {
      const settlement = settlements.get(effect.fileId);
      if (!settlement)
        throw new Error(
          "Native output effect has no admitted receipt capability.",
        );
      await settlement.settle(effect);
      settlements.delete(effect.fileId);
    },
    onProgress: (progress) =>
      job.progress({ ...progress, phase: "output_sync_" + progress.phase }),
  };
}

async function failExecution(
  options: McpOutputSyncOptions,
  session: McpOutputSyncSession,
  input: McpSyncOutput,
  job: McpOperationContext,
  error: unknown,
) {
  options.reportError(error);
  try {
    const code =
      error instanceof ReviewedOutputError ? error.code : "publication_failed";
    const receipt = await session.fail(
      code,
      job.signal.aborted || isAbortErrorLike(error),
    );
    return mcpOutputSyncJobResult({ input, receipt, jobId: job.id });
  } catch (failure) {
    throw new AggregateError(
      [error, failure],
      "Output sync failed and its durable outcome could not be recorded.",
      { cause: failure },
    );
  }
}
