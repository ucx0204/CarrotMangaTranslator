import { open, rm, lstat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { MCP_WORK_FILE_OUTPUT_BYTES } from "../../shared/mcpWorkFileExport";
import { McpEditError } from "../application/mcpEditPolicy";

/** Preserve exact encoded bytes in a newly owned artifact file. */
export async function writeMcpByteArtifact(
  file: string,
  bytes: Buffer,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  await writeFile(file, bytes, { flag: "wx", mode: 0o600, signal });
  signal?.throwIfAborted();
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function assertMcpWorkFileReservation(bytes: number): void {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > MCP_WORK_FILE_OUTPUT_BYTES
  )
    throw new McpEditError(
      "invalid_edit",
      "Working file exceeds the 128 MiB file or 256 MiB session output budget.",
    );
}

/** Validate the native writer's owned file without loading its archive into memory. */
export async function writeMcpWorkFileArtifact(
  file: string,
  writer: (file: string, signal: AbortSignal) => Promise<void>,
  reservedBytes: number,
  assertAccess: () => Promise<void>,
  signal: AbortSignal,
) {
  await assertAccess();
  await writer(file, signal);
  await assertAccess();
  const before = await lstat(file);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1 ||
    before.size > reservedBytes
  )
    throw new McpEditError(
      "invalid_edit",
      "Working file exceeds its reserved output budget.",
    );
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file, { signal })) {
    signal.throwIfAborted();
    bytes += chunk.length;
    if (bytes > reservedBytes)
      throw new McpEditError(
        "invalid_edit",
        "Working file grew beyond its reserved output budget.",
      );
    hash.update(chunk);
  }
  const after = await lstat(file);
  assertWorkFileUnchanged(before, after, bytes);
  await assertAccess();
  return { bytes, sha256: hash.digest("hex") };
}

function assertWorkFileUnchanged(
  before: Awaited<ReturnType<typeof lstat>>,
  after: Awaited<ReturnType<typeof lstat>>,
  bytes: number,
) {
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    bytes !== before.size ||
    before.size !== after.size ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new McpEditError(
      "revision_conflict",
      "Working file changed before publication.",
    );
}

/** Own the native handle until the existing source/access guard has completed. */
export async function assertReadableMcpArtifact(
  file: string,
  guard: () => Promise<void>,
): Promise<void> {
  const handle = await open(file, "r");
  try {
    await guard();
  } finally {
    await handle.close();
  }
}

/** Only an unpublished file owned by the artifact store may enter this rollback. */
export async function removeFailedMcpArtifact(
  file: string,
  operationError: unknown,
  message: string,
): Promise<never> {
  try {
    await rm(file, { force: true });
  } catch (cleanup) {
    throw new AggregateError([operationError, cleanup], message, {
      cause: cleanup,
    });
  }
  throw operationError;
}
