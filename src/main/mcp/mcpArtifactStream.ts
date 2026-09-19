import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { McpEditError } from "../application/mcpEditPolicy";
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

/** Bounded buffer reads use the same ownership lifetime as streams. */
export async function readMcpArtifactBuffer(
  entry: McpArtifactEntry,
  check: () => Promise<void>,
) {
  entry.leases++;
  try {
    const bytes = await readFile(entry.file).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT")
          throw new McpEditError(
            "not_found",
            "Output file is no longer available.",
          );
        throw error;
      },
    );
    await check();
    if (
      bytes.length !== entry.size ||
      createHash("sha256").update(bytes).digest("hex") !== entry.sha256
    )
      throw new McpEditError(
        "not_found",
        "Output bytes no longer match the published file.",
      );
    return bytes;
  } finally {
    entry.leases--;
  }
}
