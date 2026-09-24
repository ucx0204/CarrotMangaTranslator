import type { McpCompositeGuard } from "../application/mcpCompositeWorkflowPorts";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpTool } from "./mcpReadTools";
import { mcpToolResult } from "./mcpToolResult";
import type { z } from "zod/v4";

/** Internal native calls receive the same registered retention-wrapped objects as transport. */
export async function invokeMcpCompositeNativeTool(
  tools: readonly McpTool[],
  name: string,
  input: Record<string, unknown>,
  owner: string,
  guard: McpCompositeGuard,
) {
  const tool = requireMcpCompositeNativeTool(tools, name);
  guard(tool.requiredScopes);
  const result = await tool.invoke(input, {
    principalId: owner,
    assertAuthorized: () => guard(),
    assertScopes: (scopes) => guard(scopes),
    assertJobAuthorized: (scopes) => guard(scopes),
  });
  return mcpToolResult(tool, result);
}
export function requireMcpCompositeNativeTool(
  tools: readonly McpTool[],
  name: string,
) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool)
    throw new McpEditError(
      "invalid_edit",
      "A required registered native composite action is unavailable.",
    );
  return tool;
}
export type CompositeNativeRead = <S extends z.ZodType>(
  schema: S,
  name: string,
  input: Record<string, unknown>,
  owner: string,
  guard: McpCompositeGuard,
) => Promise<z.output<S>>;
export function createCompositeNativeReader(
  tools: readonly McpTool[],
): CompositeNativeRead {
  return async (schema, name, input, owner, guard) => {
    const result = await invokeMcpCompositeNativeTool(
      tools,
      name,
      input,
      owner,
      guard,
    );
    guard();
    return schema.parse(result.structuredContent);
  };
}
