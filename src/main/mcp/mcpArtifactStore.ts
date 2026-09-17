import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdtemp,
  readFile,
  lstat,
  open,
  rm,
  writeFile,
} from "node:fs/promises";
import { Readable } from "node:stream";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpEditError } from "../application/mcpEditPolicy";
import { writeMcpArtifactZip } from "./mcpArtifactZip";

type Artifact = {
  file: string;
  name: "page.png" | "pages.zip";
  mimeType: "image/png" | "application/zip";
  sha256: string;
  expiresAt: number;
  size: number;
  leases: number;
  assertAccess: () => Promise<void>;
};
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_BYTES = 128 * 1024 * 1024;
const MAX_SESSION_BYTES = 256 * 1024 * 1024;
const LIFETIME_MS = 10 * 60_000;

/** Session-owned files only. Opaque links never expose caller-selected local paths. */
export class McpArtifactStore {
  private readonly entries = new Map<string, Artifact>();
  private directory?: Promise<string>;
  private readonly lifetime = new AbortController();
  private closed = false;
  private bytes = 0;
  private readonly writes = new Set<Promise<unknown>>();
  private pruning?: Promise<void>;
  constructor(
    private readonly origin: string,
    private readonly now: () => number = Date.now,
  ) {}

  async put(bytes: Buffer, assertAccess: () => Promise<void>) {
    if (!bytes.length || bytes.length > MAX_FILE_BYTES)
      throw new McpEditError(
        "invalid_edit",
        "PNG exceeds the 64 MiB file or 256 MiB session output budget.",
      );
    const result = await this.create(
      bytes.length,
      "page.png",
      assertAccess,
      async (file) => {
        await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
        return {
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      },
    );
    return { ...result, mimeType: "image/png" as const };
  }

  async zip(
    files: { url: string; filename: string }[],
    manifest: unknown,
    assertAccess: () => Promise<void>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    await assertAccess();
    if (
      !files.length ||
      files.length > 50 ||
      new Set(files.map((item) => item.filename)).size !== files.length
    )
      throw new McpEditError(
        "invalid_edit",
        "A ZIP requires 1 to 50 distinctly named PNG outputs.",
      );
    const sources: {
      file: string;
      size: number;
      filename: string;
      check: () => Promise<void>;
    }[] = [];
    const leased: Artifact[] = [];
    try {
      for (const file of files) {
        if (!/^[0-9]+\.png$/.test(file.filename)) throw unavailable();
        const entry = await this.fromUrl(file.url);
        if (entry.name !== "page.png") throw unavailable();
        entry.leases++;
        leased.push(entry);
        sources.push({
          file: entry.file,
          size: entry.size,
          filename: file.filename,
          check: async () => {
            await this.check(entry);
          },
        });
      }
      const assertArchiveAccess = async () => {
        await assertAccess();
        // Preserve source redaction/grant checks without tying a finished ZIP
        // to source-file existence or the earlier PNG link expiry.
        for (const entry of leased) await entry.assertAccess();
        await assertAccess();
      };
      const budget =
        sources.reduce((sum, item) => sum + item.size, 0) +
        Buffer.byteLength(JSON.stringify(manifest)) +
        1024 * 1024;
      if (budget > MAX_ZIP_BYTES)
        throw new McpEditError(
          "invalid_edit",
          "ZIP exceeds the 128 MiB output budget. Select fewer pages; resolution is never reduced.",
        );
      return await this.create(
        budget,
        "pages.zip",
        assertArchiveAccess,
        (file) =>
          writeMcpArtifactZip({
            file,
            sources,
            manifest,
            assertAccess: assertArchiveAccess,
            signal: AbortSignal.any([signal, this.lifetime.signal]),
          }),
      );
    } finally {
      for (const entry of leased) entry.leases--;
    }
  }

  async read(secret: string) {
    const entry = await this.lookup(secret);
    entry.leases++;
    try {
      const bytes = await readFile(entry.file).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") throw unavailable();
          throw error;
        },
      );
      await this.check(entry);
      if (bytes.length !== entry.size) throw unavailable();
      return bytes;
    } finally {
      entry.leases--;
    }
  }

  async open(secret: string, name: string) {
    const entry = await this.lookup(secret);
    if (entry.name !== name) throw unavailable();
    // HEAD and stream setup must establish readability, not just file existence.
    const handle = await open(entry.file, "r");
    try {
      await this.check(entry);
    } finally {
      await handle.close();
    }
    return {
      bytes: entry.size,
      mimeType: entry.mimeType,
      filename:
        entry.name === "page.png" ? "carrot-page.png" : "carrot-pages.zip",
      stream: () => Readable.from(this.chunks(entry)),
    };
  }
  async assertAvailable(url: string): Promise<void> {
    const entry = await this.fromUrl(url);
    if (entry.name === "page.png") {
      await this.read(new URL(url).pathname.split("/")[2]);
      return;
    }
    // Opening the ZIP verifies readability without loading the archive into memory.
    const handle = await open(entry.file, "r");
    try {
      await this.check(entry);
    } finally {
      await handle.close();
    }
  }
  stop(): void {
    this.closed = true;
    this.lifetime.abort();
  }
  async close(): Promise<void> {
    this.stop();
    await Promise.allSettled([...this.writes, this.pruning]);
    this.entries.clear();
    if (this.directory)
      await rm(await this.directory, { recursive: true, force: true });
    this.bytes = 0;
  }

  private async *chunks(entry: Artifact) {
    entry.leases++;
    const input = createReadStream(entry.file, {
      highWaterMark: 1024 * 1024,
      signal: this.lifetime.signal,
    });
    try {
      for await (const chunk of input) {
        await this.check(entry);
        yield chunk;
      }
      await this.check(entry);
    } finally {
      input.destroy();
      entry.leases--;
    }
  }
  private async lookup(secret: string) {
    const entry = this.entries.get(digest(secret));
    if (!entry) throw unavailable();
    await this.check(entry);
    return entry;
  }
  private async fromUrl(url: string) {
    const prefix = `${this.origin}/mcp-artifacts/`;
    if (!url.startsWith(prefix)) throw unavailable();
    const match = /^([A-Za-z0-9_-]{43})\/(page\.png|pages\.zip)$/.exec(
      url.slice(prefix.length),
    );
    if (!match) throw unavailable();
    const entry = await this.lookup(match[1]);
    if (entry.name !== match[2]) throw unavailable();
    return entry;
  }
  private async check(entry: Artifact) {
    if (this.closed || entry.expiresAt <= this.now()) throw unavailable();
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
    if (this.closed || entry.expiresAt <= this.now()) throw unavailable();
  }

  private async create(
    reserved: number,
    name: Artifact["name"],
    assertAccess: Artifact["assertAccess"],
    writer: (file: string) => Promise<{ bytes: number; sha256: string }>,
  ) {
    await assertAccess();
    await this.prune();
    if (this.closed) throw unavailable();
    if (this.bytes + reserved > MAX_SESSION_BYTES)
      throw new McpEditError(
        "invalid_edit",
        "Output exceeds the 256 MiB session budget. Select fewer pages or wait for older output expiry.",
      );
    const secret = randomBytes(32).toString("base64url");
    this.bytes += reserved;
    const task = this.write(
      digest(secret),
      reserved,
      name,
      assertAccess,
      writer,
    );
    this.writes.add(task);
    try {
      const entry = await task;
      this.bytes += entry.size - reserved;
      return {
        url: `${this.origin}/mcp-artifacts/${secret}/${name}`,
        mimeType: entry.mimeType,
        bytes: entry.size,
        sha256: entry.sha256,
        expiresAt: entry.expiresAt,
        access:
          "single-file-link; expires on stop, revocation, page change or redaction change",
      };
    } catch (error) {
      this.bytes -= reserved;
      throw error;
    } finally {
      this.writes.delete(task);
    }
  }
  private prune(): Promise<void> {
    // Concurrent admissions must share both successful and failed cleanup.
    this.pruning ??= this.removeExpired().finally(() => {
      this.pruning = undefined;
    });
    return this.pruning;
  }
  private async removeExpired(): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > this.now() || entry.leases) continue;
      await rm(entry.file, { force: true });
      this.entries.delete(key);
      this.bytes -= entry.size;
    }
  }
  private async write(
    key: string,
    reserved: number,
    name: Artifact["name"],
    assertAccess: Artifact["assertAccess"],
    writer: (file: string) => Promise<{ bytes: number; sha256: string }>,
  ) {
    this.directory ??= mkdtemp(join(tmpdir(), "carrot-mcp-exports-"));
    const file = join(await this.directory, `${randomUUID()}-${name}`);
    if (this.closed) throw unavailable();
    try {
      const result = await writer(file);
      await assertAccess();
      if (this.closed || result.bytes > reserved) throw unavailable();
      const entry: Artifact = {
        file,
        name,
        mimeType: name === "page.png" ? "image/png" : "application/zip",
        size: result.bytes,
        sha256: result.sha256,
        expiresAt: this.now() + LIFETIME_MS,
        leases: 0,
        assertAccess,
      };
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
