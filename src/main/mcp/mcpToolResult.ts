import type { McpTool } from "./mcpReadTools";
import { McpEditError, mcpStorageFailure } from "../application/mcpEditPolicy";
import { mcpOutputSchemas } from "./mcpOutputSchemas";
import { McpInvalidParams } from "./mcpArguments";

export function mcpToolResult(
  tool: McpTool,
  content: Awaited<ReturnType<McpTool["invoke"]>>,
) {
  const schema = mcpOutputSchemas[tool.name];
  if (!schema) return { content, isError: false };
  const metadata = content[0];
  if (metadata?.type !== "text")
    throw new Error("MCP output metadata is missing.");
  const parsed = schema.safeParse(JSON.parse(metadata.text));
  if (!parsed.success)
    throw new Error(`MCP output contract failed for ${tool.name}.`);
  return { content, structuredContent: parsed.data, isError: false };
}

export function mcpToolError(error: unknown) {
  const { code, message } = describeFailure(error);
  const guidance: Record<string, string> = {
    revision_conflict:
      "Read the current page and review changes before retrying.",
    editor_busy: "Save local edits or wait for the active app job, then retry.",
    retention_full:
      "The app automatically rotates ordinary recovery history. Check the actual storage error; do not ask the user to delete recovery records or repeat completed work.",
    history_reclaimed:
      "Older undo history was automatically rotated; saved pages are intact. Read the current page. Do not repeat the original operation or claim that saving failed.",
    storage_full:
      "Free space on the storage device, then inspect the current saved state before retrying. Do not delete originals or outputs automatically.",
    job_detail_unavailable:
      "Saved details are damaged or missing, but this request remains protected. Repair storage and restart; do not resubmit the operation with a new request ID.",
    not_found: "List current targets or owned jobs before retrying.",
    invalid_edit: "Correct the arguments; do not retry unchanged.",
    invalid_arguments:
      "Correct the reported fields using this tool's inputSchema in tools/list, then retry. No operation was started.",
    editor_open:
      "Close this chapter in the app, preserving any local edits, then retry. Waiting alone will not close the editor.",
    access_denied:
      "Check this connection's approval in the app. Do not bypass permissions.",
  };
  const structuredContent = {
    error: code,
    message,
    retryable: code === "editor_busy",
    nextAction:
      guidance[code] ??
      "Check the local app log and resulting page before retrying.",
    ...(error instanceof McpInvalidParams ? { issues: error.issues } : {}),
  };
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(structuredContent) },
    ],
    structuredContent,
    isError: true,
  };
}

function describeFailure(error: unknown) {
  if (error instanceof McpInvalidParams)
    return { code: "invalid_arguments", message: error.message };
  if (error instanceof McpEditError)
    return { code: error.code, message: error.message };
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "APP_ACTIVITY_BUSY"
  )
    return {
      code: "editor_busy",
      message: "Another app operation temporarily owns the required resources.",
    };
  return (
    mcpStorageFailure(error) ?? {
      code: "operation_failed",
      message:
        "The app could not complete this operation. Check its local log; no internal paths or error details are returned here.",
    }
  );
}
