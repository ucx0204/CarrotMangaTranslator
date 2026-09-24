import type { McpCompositeGuard } from "../application/mcpCompositeWorkflowPorts";

export function authorizeMcpComposite(
  guard: () => void,
  authorize: (scopes: readonly string[]) => void,
): McpCompositeGuard {
  return (required) => {
    guard();
    if (required?.length) authorize(required);
  };
}
