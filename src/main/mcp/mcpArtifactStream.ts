import { createReadStream } from "node:fs";
import type { McpArtifactEntry } from "./mcpArtifactTypes";

/** Backpressured file reads retain the owned entry and recheck authority for every chunk. */
export async function* readMcpArtifactChunks(
  entry: McpArtifactEntry,
  check: () => Promise<void>,
  signal: AbortSignal,
) {
  entry.leases++;
  const input = createReadStream(entry.file, {
    highWaterMark: 1024 * 1024,
    signal: signal,
  });
  try {
    for await (const chunk of input) {
      await check();
      yield chunk;
    }
    await check();
  } finally {
    input.destroy();
    entry.leases--;
  }
}
