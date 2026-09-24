import { readImageRedactionState } from "../imageRedactionStore";
import { McpEditError } from "../application/mcpEditPolicy";
import { ReviewedOutputError } from "../linkedWorkspace/linkedWorkspaceReviewedOutputTypes";
import type { McpTool } from "./mcpReadTools";

export const OUTPUT_SYNC_READ_SCOPES = ["carrot.read"];
export const OUTPUT_SYNC_IMAGE_SCOPES = ["carrot.read", "carrot.images"];
export const OUTPUT_SYNC_WRITE_SCOPES = [
  "carrot.read",
  "carrot.edit",
  "carrot.process",
  "carrot.images",
];

export function outputSyncCaller(
  context: Parameters<McpTool["invoke"]>[1],
  scopes: readonly string[],
  lifetime: AbortSignal,
  background = false,
) {
  if (
    !context?.principalId ||
    !context.assertScopes ||
    (background && !context.assertJobAuthorized)
  )
    throw new McpEditError(
      "access_denied",
      "An approved connection with explicit output scopes is required.",
    );
  const caller = context;
  const guard = () => {
    lifetime.throwIfAborted();
    caller.assertAuthorized();
    caller.assertScopes?.(scopes);
  };
  guard();
  const jobGuard = () => {
    lifetime.throwIfAborted();
    if (!caller.assertJobAuthorized)
      throw new McpEditError(
        "access_denied",
        "Output job authorization is unavailable.",
      );
    caller.assertJobAuthorized(scopes);
  };
  return { owner: context.principalId, guard, jobGuard };
}

export async function assertOutputSyncImages(
  allowed: boolean,
  guard: () => void,
) {
  guard();
  if (!allowed || (await readImageRedactionState()).enabled)
    throw new McpEditError(
      "access_denied",
      "Output synchronization is blocked by local image permissions or redaction review.",
    );
  guard();
}

export function rethrowOutputSyncError(error: unknown): never {
  if (!(error instanceof ReviewedOutputError)) throw error;
  const code =
    error.code === "destination_unavailable"
      ? "not_found"
      : ["destination_changed", "selection_changed", "source_changed"].includes(
            error.code,
          )
        ? "revision_conflict"
        : "invalid_edit";
  throw new McpEditError(
    code,
    "Output synchronization review failed: " + error.code + ".",
    { cause: error },
  );
}
