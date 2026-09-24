import { z } from "zod/v4";
import {
  McpGetOutputDestinationSchema,
  McpPreflightOutputSyncSchema,
  McpSyncOutputSchema,
  McpGetOutputSyncSchema,
  McpOutputSyncPreflightSchema,
  McpOutputDestinationSchema,
  type McpSyncOutput,
} from "../../shared/mcpOutputSync";
import { ReviewedOutputError } from "../linkedWorkspace/linkedWorkspaceReviewedOutputTypes";
import type { McpOutputSyncOptions } from "./mcpOutputSyncTypes";
import { McpInvalidParams } from "./mcpArguments";
import { textContent, type McpTool } from "./mcpReadTools";
import { withMcpAuthorization } from "./mcpAuthorizationScope";
import {
  OUTPUT_SYNC_READ_SCOPES,
  OUTPUT_SYNC_IMAGE_SCOPES,
  OUTPUT_SYNC_WRITE_SCOPES,
  outputSyncCaller,
  assertOutputSyncImages,
  rethrowOutputSyncError,
} from "./mcpOutputSyncAuthority";
import { inspectMcpOutputSync } from "./mcpOutputSyncInspection";
import { outputSyncHistoricalJob } from "./mcpOutputSyncHistory";
import { executeMcpOutputSync } from "./mcpOutputSyncExecution";

type Track = <T>(task: Promise<T>) => Promise<T>;

export function createMcpOutputSyncTools(
  options: McpOutputSyncOptions,
  lifetime: AbortSignal,
  track: Track,
): McpTool[] {
  const tools: McpTool[] = [
    readTool(
      "carrot_get_output_destination",
      McpGetOutputDestinationSchema,
      OUTPUT_SYNC_READ_SCOPES,
      "Inspect the current native linked output connection for ONE chapter. Returns opaque connection ID, enabled/available status, existing format settings and bounded complete shared-root mirror scope. No paths, rendering, model, queue, folder creation or writes.",
      async (input, _owner, guard) => {
        if (!options.port)
          throw new ReviewedOutputError("destination_unavailable");
        return McpOutputDestinationSchema.parse(
          await options.port.inspect(input.chapterId, guard),
        );
      },
      lifetime,
      track,
    ),
    readTool(
      "carrot_get_output_sync",
      McpGetOutputSyncSchema,
      OUTPUT_SYNC_READ_SCOPES,
      "Inspect one owned retained output-sync receipt by ID or original requestId. Separately hashes bounded current files only when the current native destination still matches. Historical publication remains distinct from current-byte matches; no rendering, model, source validation, URL, replay or write. An unconfirmed historical publication stays unconfirmed even when current bytes match.",
      (input, owner, guard) =>
        inspectMcpOutputSync(options, owner, input, guard),
      lifetime,
      track,
    ),
  ];
  if (options.preferences.allowImages)
    tools.push(
      readTool(
        "carrot_preflight_output_sync",
        McpPreflightOutputSyncSchema,
        OUTPUT_SYNC_IMAGE_SCOPES,
        "Review 1-50 selected saved pages in ONE currently connected chapter for native output synchronization. The shared root must contain at most 10 chapters/50 current pages. Returns selected page revisions, three snapshots, explicit per-file actions and COMPLETE recovery-mirror scope including saved text. Existing native format/allocation only; no path input, fallback, queue work, render, model or writes. Images are bounded to 64 MiB, mirror/registry to 16 MiB, all published bytes to 256 MiB. Does not reserve execution. Keep the exact review and acknowledge partial per-file publication and saved-text mirror before carrot_sync_output.",
        async (input, _owner, guard) => {
          await assertOutputSyncImages(options.preferences.allowImages, guard);
          if (!options.port)
            throw new ReviewedOutputError("destination_unavailable");
          const review = await options.port.preflight(input, guard);
          await assertOutputSyncImages(options.preferences.allowImages, guard);
          return McpOutputSyncPreflightSchema.parse(review);
        },
        lifetime,
        track,
      ),
    );
  if (
    options.preferences.allowImages &&
    options.preferences.allowEditing &&
    options.preferences.allowProcessing
  )
    tools.push(syncTool(options, lifetime, track));
  return tools;
}

function readTool<S extends z.ZodType>(
  name: string,
  schema: S,
  scopes: string[],
  description: string,
  execute: (
    input: z.output<S>,
    owner: string,
    guard: () => void,
  ) => Promise<unknown>,
  lifetime: AbortSignal,
  track: Track,
): McpTool {
  return {
    name,
    description,
    requiredScopes: scopes,
    oauth: true,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    inputSchema: z.toJSONSchema(schema),
    invoke: (args, caller) =>
      track(
        (async () => {
          const authority = outputSyncCaller(caller, scopes, lifetime);
          const input = schema.safeParse(args);
          if (!input.success) throw new McpInvalidParams();
          return withMcpAuthorization(
            authority.guard,
            lifetime,
            async (guard) =>
              textContent(await execute(input.data, authority.owner, guard)),
          );
        })().catch(rethrowOutputSyncError),
      ),
  };
}

function syncTool(
  options: McpOutputSyncOptions,
  lifetime: AbortSignal,
  track: Track,
): McpTool {
  return {
    name: "carrot_sync_output",
    requiredScopes: OUTPUT_SYNC_WRITE_SCOPES,
    description:
      "Synchronize the exact reviewed selected saved pages to their existing native linked destination. Requires unchanged connection/page IDs and three snapshots, requestId, confirm=true, acknowledgePartialPublication=true and acknowledgeSavedTextMirror=true. Repeating a request first returns its ORIGINAL retained job/receipt without rendering or reexecution. New work uses native app page handoff, result/inpainted/mask writers, per-file durable intent/effect records, canonical registry and the complete shared-root saved-text mirror. Stops on failure/cancel; already published files remain. No batch rollback, queue drain, fallback, Explorer, OCR, translation, erasure or model. Poll carrot_get_job and inspect carrot_get_output_sync; no file attachments or URLs.",
    oauth: true,
    readOnly: false,
    destructive: true,
    idempotent: true,
    openWorld: false,
    inputSchema: z.toJSONSchema(McpSyncOutputSchema),
    invoke: (args, caller) =>
      track(
        (async () => {
          const authority = outputSyncCaller(
            caller,
            OUTPUT_SYNC_WRITE_SCOPES,
            lifetime,
            true,
          );
          const input = McpSyncOutputSchema.safeParse(args);
          if (!input.success) throw new McpInvalidParams();
          return withMcpAuthorization(
            authority.guard,
            lifetime,
            async (guard) =>
              textContent(
                await startOutputSync(
                  options,
                  input.data,
                  authority.owner,
                  guard,
                  authority.jobGuard,
                  lifetime,
                  track,
                ),
              ),
          );
        })().catch(rethrowOutputSyncError),
      ),
  };
}

async function startOutputSync(
  options: McpOutputSyncOptions,
  input: McpSyncOutput,
  owner: string,
  guard: () => void,
  jobGuard: () => void,
  lifetime: AbortSignal,
  track: Track,
) {
  const previous = await options.repository.find(owner, input, guard);
  if (previous)
    return outputSyncHistoricalJob(
      options.operations,
      owner,
      input,
      previous,
      guard,
    );
  await assertOutputSyncImages(options.preferences.allowImages, guard);
  if (!options.port) throw new ReviewedOutputError("destination_unavailable");
  const review = McpOutputSyncPreflightSchema.parse(
    await options.port.preflight(
      {
        chapterId: input.chapterId,
        connectionId: input.connectionId,
        pageIds: input.pageIds,
      },
      guard,
    ),
  );
  if (
    review.chapterId !== input.chapterId ||
    review.connectionId !== input.connectionId ||
    JSON.stringify(review.pageIds) !== JSON.stringify(input.pageIds)
  )
    throw new ReviewedOutputError("selection_changed");
  if (review.selectionSnapshot !== input.selectionSnapshot)
    throw new ReviewedOutputError("selection_changed");
  if (review.destinationSnapshot !== input.destinationSnapshot)
    throw new ReviewedOutputError("destination_changed");
  if (review.sourceSnapshot !== input.sourceSnapshot)
    throw new ReviewedOutputError("source_changed");
  await assertOutputSyncImages(options.preferences.allowImages, guard);
  return options.operations.start({
    owner,
    requestId: input.requestId,
    kind: "outputSync",
    parameters: input,
    assertAuthorized: jobGuard,
    execute: (job) =>
      track(executeMcpOutputSync(options, owner, input, review, job, lifetime)),
  });
}
