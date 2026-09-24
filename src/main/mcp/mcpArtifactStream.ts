import { createHash } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import { McpEditError } from "../application/mcpEditPolicy";
import { createReadStream } from "node:fs";
import type {
  McpArtifactEntry,
  McpRetainedArtifactMetadata,
} from "./mcpArtifactTypes";
import { Readable } from "node:stream";
import { assertReadableMcpArtifact } from "./mcpArtifactFiles";
import type {
  McpOutputDeliveryObserver,
  McpOutputDeliveryTransfer,
} from "./mcpOutputDeliveryObserver";
import { mcpArtifactName } from "../../shared/mcpOutputFormats";

/** Retained files stay borrowed; admission performs the same final access/file check. */
export async function openBorrowedMcpArtifact(
  file: string,
  metadata: McpRetainedArtifactMetadata,
  access: {
    assertAccess: () => Promise<void>;
    verifyOpen: () => Promise<void>;
    expiresAt: number;
    check: (entry: McpArtifactEntry) => Promise<void>;
  },
) {
  const entry: McpArtifactEntry = {
    file,
    name: mcpArtifactName(metadata.mimeType),
    mimeType: metadata.mimeType,
    sha256: metadata.sha256,
    size: metadata.bytes,
    expiresAt: access.expiresAt,
    leases: 0,
    borrowed: true,
    assertAccess: access.assertAccess,
    verifyOpen: access.verifyOpen,
    bindings: metadata.bindings ?? [],
    workFileBinding: metadata.workFileBinding,
    exchangeBinding: metadata.exchangeBinding,
    retainedOutputId: metadata.retainedOutputId,
  };
  await access.check(entry);
  return entry;
}

/** Describe and observe a capability only after its owned entry has been admitted. */
export function issueMcpArtifactCapability(
  origin: string,
  secret: string,
  entry: McpArtifactEntry,
  observer: McpOutputDeliveryObserver,
  kind: "generated" | "reissued",
) {
  observer.created({
    artifactKey: createHash("sha256").update(secret).digest("hex"),
    retainedOutputId: entry.retainedOutputId,
    expiresAt: entry.expiresAt,
    origin: kind,
  });
  return {
    ...(kind === "generated" && entry.retainedOutputId
      ? { retainedOutputId: entry.retainedOutputId }
      : {}),
    url: `${origin}/mcp-artifacts/${secret}/${entry.name}`,
    mimeType: entry.mimeType,
    bytes: entry.size,
    sha256: entry.sha256,
    expiresAt: entry.expiresAt,
    access:
      kind === "generated"
        ? "single-file-link; expires on stop, revocation, page change or redaction change"
        : "fresh-single-file-link; expires on stop, revocation, page/source/redaction change or retained expiry",
  };
}

/** Open only the checked, fixed-name output and keep its transfer identity private. */
export async function openMcpArtifact(
  entry: McpArtifactEntry,
  check: () => Promise<void>,
  signal: AbortSignal,
  beginHttp: (method: "GET" | "HEAD") => McpOutputDeliveryTransfer,
) {
  await assertReadableMcpArtifact(entry.file, check);
  return {
    bytes: entry.size,
    mimeType: entry.mimeType,
    filename: `carrot-${entry.name}`,
    beginHttp,
    stream: (transfer?: McpOutputDeliveryTransfer) =>
      Readable.from(readMcpArtifactChunks(entry, check, signal, transfer)),
  };
}

export async function assertAvailableMcpArtifact(
  entry: McpArtifactEntry,
  check: () => Promise<void>,
): Promise<void> {
  if (entry.name === "pages.zip" || entry.name === "work.mgtshare")
    await assertReadableMcpArtifact(entry.file, check);
  else await readMcpArtifactBuffer(entry, check);
}

/** Recheck authority on both sides of filesystem access before a read or publication. */
export async function checkMcpArtifactEntry(
  entry: McpArtifactEntry,
  live: () => boolean,
) {
  if (!live()) throw unavailable();
  await entry.assertAccess();
  const stats = await lstat(entry.file).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw unavailable();
      throw error;
    },
  );
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== entry.size)
    throw unavailable();
  await entry.assertAccess();
  if (!live()) throw unavailable();
}

/** Backpressured file reads retain the owned entry and recheck authority for every chunk. */
async function* readMcpArtifactChunks(
  entry: McpArtifactEntry,
  check: () => Promise<void>,
  signal: AbortSignal,
  transfer?: McpOutputDeliveryTransfer,
) {
  entry.leases++;
  const input = createReadStream(entry.file, {
    highWaterMark: 1024 * 1024,
    signal: signal,
  });
  try {
    for await (const chunk of input) {
      await check();
      transfer?.bytesQueued(chunk.length);
      yield chunk;
    }
    await check();
  } finally {
    input.destroy();
    entry.leases--;
  }
}

function unavailable() {
  return new McpEditError(
    "not_found",
    "Output link is unavailable or expired. Inspect retained outputs or explicitly export again.",
  );
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
