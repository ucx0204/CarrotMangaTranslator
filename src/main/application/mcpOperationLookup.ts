import { McpEditError } from "./mcpEditPolicy";

export type McpOwnedOperationRequest = {
  requestId: string;
  kind: string;
  fingerprint: string;
};
type Entry = {
  owner: string;
  requestId: string;
  kind: string;
  fingerprint: string;
};

/** Internal receipt proof against the native journal's canonical input hash. */
export function findOwnedMcpOperation<T extends Entry>(
  entries: Iterable<T>,
  owner: string,
  input: McpOwnedOperationRequest,
): T | undefined {
  for (const entry of entries) {
    if (entry.owner !== owner || entry.requestId !== input.requestId) continue;
    if (entry.kind !== input.kind || entry.fingerprint !== input.fingerprint)
      throw new McpEditError(
        "invalid_edit",
        "Native requestId belongs to a different operation or input.",
      );
    return entry;
  }
  return undefined;
}
