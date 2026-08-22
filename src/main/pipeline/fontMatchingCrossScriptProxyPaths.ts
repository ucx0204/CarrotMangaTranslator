import { join } from "node:path";

/** Resolve the bundled visual model without consulting writable state. */
export function resolveCrossScriptProxyRuntimeDir(runtimeDir: string): string {
  return join(runtimeDir, "font-matching-crossscript-proxy");
}
