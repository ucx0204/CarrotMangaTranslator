import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpEditError } from "../application/mcpEditPolicy";

type Artifact = {
  file: string;
  expiresAt: number;
  size: number;
  assertAccess: () => Promise<void>;
};
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_BYTES = 256 * 1024 * 1024;
const LIFETIME_MS = 10 * 60_000;

/** Session-owned output only. The opaque URL grants access to one PNG for ten
 * minutes, subject to current authorization, revision and redaction checks. */
export class McpArtifactStore {
  private readonly entries = new Map<string, Artifact>();
  private directory?: Promise<string>;
  private closed = false;
  private bytes = 0;
  private readonly writes = new Set<Promise<unknown>>();
  constructor(
    private readonly origin: string,
    private readonly now: () => number = Date.now,
  ) {}

  async put(bytes: Buffer, assertAccess: () => Promise<void>) {
    await assertAccess();
    await this.prune();
    if (this.closed) throw unavailable();
    if (
      !bytes.length ||
      bytes.length > MAX_FILE_BYTES ||
      this.bytes + bytes.length > MAX_SESSION_BYTES
    )
      throw new McpEditError(
        "invalid_edit",
        "PNG exceeds the 64 MiB file or 256 MiB session output budget.",
      );
    const secret = randomBytes(32).toString("base64url");
    const key = digest(secret);
    this.bytes += bytes.length;
    const task = this.write(key, bytes, assertAccess);
    this.writes.add(task);
    try {
      const entry = await task;
      return {
        url: `${this.origin}/mcp-artifacts/${secret}/page.png`,
        mimeType: "image/png" as const,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        expiresAt: entry.expiresAt,
        access:
          "single-file-link; expires on stop, revocation, page change or redaction change",
      };
    } catch (error) {
      this.bytes -= bytes.length;
      throw error;
    } finally {
      this.writes.delete(task);
    }
  }
  async read(secret: string) {
    const entry = this.entries.get(digest(secret));
    if (this.closed || !entry || entry.expiresAt <= this.now())
      throw unavailable();
    await entry.assertAccess();
    const bytes = await readFile(entry.file);
    await entry.assertAccess();
    if (
      this.closed ||
      entry.expiresAt <= this.now() ||
      bytes.length !== entry.size
    )
      throw unavailable();
    return bytes;
  }
  stop(): void {
    this.closed = true;
  }
  async close(): Promise<void> {
    this.stop();
    await Promise.allSettled([...this.writes]);
    this.entries.clear();
    if (this.directory)
      await rm(await this.directory, { recursive: true, force: true });
    this.bytes = 0;
  }
  private async prune(): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > this.now()) continue;
      this.entries.delete(key);
      this.bytes -= entry.size;
      await rm(entry.file, { force: true });
    }
  }
  private async write(
    key: string,
    bytes: Buffer,
    assertAccess: () => Promise<void>,
  ) {
    this.directory ??= mkdtemp(join(tmpdir(), "carrot-mcp-exports-"));
    const file = join(await this.directory, `${randomUUID()}.png`);
    if (this.closed) throw unavailable();
    await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    const entry = {
      file,
      size: bytes.length,
      expiresAt: this.now() + LIFETIME_MS,
      assertAccess,
    };
    try {
      await assertAccess();
      if (this.closed) throw unavailable();
      this.entries.set(key, entry);
      return entry;
    } catch (error) {
      try {
        await rm(file, { force: true });
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "Output write and cleanup failed.",
          { cause: cleanup },
        );
      }
      throw error;
    }
  }
}
function digest(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}
function unavailable() {
  return new McpEditError(
    "not_found",
    "Output link is unavailable or expired. Export the current page again.",
  );
}
