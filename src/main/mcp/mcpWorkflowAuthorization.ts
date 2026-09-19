import type { McpWorkflowRecord } from "../application/mcpWorkflowPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpTool } from "./mcpReadTools";

type Context = NonNullable<Parameters<McpTool["invoke"]>[1]>;

/** Both execution and ownership acceptance require current approval for every stage. */
export function authorizeMcpWorkflow(
  context: Context,
  record: McpWorkflowRecord,
) {
  const scopes = [
    "carrot.read",
    "carrot.edit",
    "carrot.process",
    ...(record.input.stages.some((stage) => stage.kind === "export-png")
      ? ["carrot.images"]
      : []),
  ];
  if (context.assertJobAuthorized) context.assertJobAuthorized(scopes);
  else {
    context.assertAuthorized();
    if (!context.assertScopes)
      throw new McpEditError(
        "access_denied",
        "Scope verification is required.",
      );
    context.assertScopes(scopes);
  }
}
