import { z } from "zod/v4";
import { McpEditError } from "../application/mcpEditPolicy";
import { McpInvalidParams } from "./mcpArguments";
import { textContent, type McpTool } from "./mcpReadTools";

export function createMcpBatchTool(options: {
  name: string;
  description: string;
  schema: z.ZodType;
  scopes: string[];
  write: boolean;
  background?: boolean;
  execute: (
    args: unknown,
    owner: string,
    guard: () => void,
  ) => Promise<unknown>;
}): McpTool {
  return {
    name: options.name,
    description: options.description,
    inputSchema: z.toJSONSchema(options.schema),
    oauth: true,
    requiredScopes: options.scopes,
    readOnly: !options.write,
    destructive: options.write && !options.name.includes("cancel"),
    idempotent: true,
    invoke: async (args, context) => {
      if (!context?.principalId)
        throw new McpEditError(
          "access_denied",
          "An approved connection is required.",
        );
      const guard = () => {
        if (options.background && context.assertJobAuthorized) {
          context.assertJobAuthorized(options.scopes);
        } else {
          context.assertAuthorized();
          context.assertScopes?.(options.scopes);
        }
      };
      guard();
      const parsed = options.schema.safeParse(args);
      if (!parsed.success) throw new McpInvalidParams();
      return textContent(
        await options.execute(parsed.data, context.principalId, guard),
      );
    },
  };
}
