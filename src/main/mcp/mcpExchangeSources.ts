import type { McpExchangeBinding } from "../../shared/mcpExchangeFiles";
import { checkMcpTextExchangeBindingUnlocked } from "./mcpTextExportSource";
import { checkMcpContextExchangeBindingUnlocked } from "./mcpContextExchangeSource";

/** The caller owns the existing native read/mutation lock. */
export function checkMcpExchangeBindingUnlocked(
  binding: McpExchangeBinding,
  guard?: () => void,
  signal?: AbortSignal,
): Promise<void> {
  return binding.kind === "text"
    ? checkMcpTextExchangeBindingUnlocked(binding, guard, signal)
    : checkMcpContextExchangeBindingUnlocked(binding, guard, signal);
}
