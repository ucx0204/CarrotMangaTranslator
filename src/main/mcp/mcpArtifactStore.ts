import {
  removeFailedMcpArtifact,
  assertMcpWorkFileReservation,
  writeMcpWorkFileArtifact,
  writeMcpByteArtifact,
} from "./mcpArtifactFiles";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mcpArtifactMime,
  mcpPageOutputFormat,
  type McpPageExportOptions,
} from "../../shared/mcpOutputFormats";
import {
  readMcpArtifactBuffer,
  openMcpArtifact,
  assertAvailableMcpArtifact,
  checkMcpArtifactEntry,
  issueMcpArtifactCapability,
  openBorrowedMcpArtifact,
} from "./mcpArtifactStream";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpEditError } from "../application/mcpEditPolicy";
import { createMcpArtifactZip } from "./mcpArtifactZip";
import type {
  McpArtifactBinding,
  McpArtifactRetention,
  McpArtifactEntry as Artifact,
  McpRetainedArtifactMetadata,
} from "./mcpArtifactTypes";
import type { McpWorkFileExportBinding } from "../../shared/mcpWorkFileExport";
import { McpOutputDeliveryObserver } from "./mcpOutputDeliveryObserver";
import {
  MCP_EXCHANGE_BYTES,
  McpExchangeBindingSchema,
  mcpExchangeIdentity,
  type McpExchangeBinding,
} from "../../shared/mcpExchangeFiles";
type ArtifactSource = Pick<
  Artifact,
  "bindings" | "workFileBinding" | "exchangeBinding"
>;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
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
    private readonly retain?: McpArtifactRetention,
    private readonly observer = new McpOutputDeliveryObserver(now),
  ) {}

  async put(
    bytes: Buffer,
    assertAccess: () => Promise<void>,
    target?: McpArtifactBinding,
  ) {
    const result = await this.putImage(bytes, "png", assertAccess, target);
    return { ...result, mimeType: "image/png" as const };
  }

  async putImage(
    bytes: Buffer,
    format: McpPageExportOptions["format"],
    assertAccess: () => Promise<void>,
    target?: McpArtifactBinding,
  ) {
    const identity = mcpPageOutputFormat(format);
    if (!bytes.length || bytes.length > MAX_FILE_BYTES)
      throw new McpEditError(
        "invalid_edit",
        "Image exceeds the 64 MiB file or 256 MiB session output budget.",
      );
    const result = await this.create(
      bytes.length,
      identity.name,
      assertAccess,
      (file) => writeMcpByteArtifact(file, bytes),
      { bindings: target ? [target] : [] },
    );
    return { ...result, mimeType: identity.mimeType };
  }

  async zip(
    files: { url: string; filename: string }[],
    manifest: unknown,
    assertAccess: () => Promise<void>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    await assertAccess();
    const archive = await createMcpArtifactZip(
      files,
      (url) => this.fromUrl(url),
      (entry) => this.check(entry),
      assertAccess,
      manifest,
      AbortSignal.any([signal, this.lifetime.signal]),
      (reserved, access, writer, bindings) =>
        this.create(reserved, "pages.zip", access, writer, { bindings }),
    );
    return { ...archive, mimeType: "application/zip" as const };
  }

  async putWorkFile(
    writer: (file: string, signal: AbortSignal) => Promise<void>,
    reservedBytes: number,
    assertAccess: () => Promise<void>,
    signal: AbortSignal,
    bindings: McpArtifactBinding[],
    workFileBinding: McpWorkFileExportBinding,
  ) {
    assertMcpWorkFileReservation(reservedBytes);
    const linked = AbortSignal.any([signal, this.lifetime.signal]);
    const access = async () => {
      linked.throwIfAborted();
      await assertAccess();
      linked.throwIfAborted();
    };
    return this.create(
      reservedBytes,
      "work.mgtshare",
      access,
      (file) =>
        writeMcpWorkFileArtifact(file, writer, reservedBytes, access, linked),
      { bindings, workFileBinding },
      linked,
    );
  }

  async putExchange(
    bytes: Buffer,
    binding: McpExchangeBinding,
    assertAccess: () => Promise<void>,
    signal: AbortSignal,
  ) {
    const exchangeBinding = McpExchangeBindingSchema.parse(binding);
    if (!bytes.length || bytes.length > MCP_EXCHANGE_BYTES)
      throw new McpEditError(
        "invalid_edit",
        "Exchange output exceeds the 4 MiB encoded-byte limit.",
      );
    const linked = AbortSignal.any([signal, this.lifetime.signal]);
    const access = async () => {
      linked.throwIfAborted();
      await assertAccess();
      linked.throwIfAborted();
    };
    return this.create(
      bytes.length,
      mcpExchangeIdentity(exchangeBinding).name,
      access,
      (file) => writeMcpByteArtifact(file, bytes, linked),
      { bindings: [], exchangeBinding },
      linked,
    );
  }

  async read(secret: string) {
    const entry = await this.lookup(secret);
    return readMcpArtifactBuffer(entry, () => this.check(entry));
  }

  async open(secret: string, name: string) {
    const entry = await this.lookup(secret);
    if (entry.name !== name) throw unavailable();
    return openMcpArtifact(
      entry,
      () => this.check(entry),
      this.lifetime.signal,
      (method) => this.observer.beginHttp(digest(secret), method),
    );
  }
  async assertAvailable(url: string): Promise<void> {
    const entry = await this.fromUrl(url);
    await assertAvailableMcpArtifact(entry, () => this.check(entry));
  }
  /** Native-only identity after owned capability and current authority checks. */
  async observation(url: string) {
    const entry = await this.fromUrl(url);
    return {
      artifactKey: digest(new URL(url).pathname.split("/")[2]),
      expiresAt: entry.expiresAt,
      ...(entry.retainedOutputId
        ? { retainedOutputId: entry.retainedOutputId }
        : {}),
    };
  }
  async disclosed(url: string, includeAttachment: boolean): Promise<void> {
    const { artifactKey } = await this.observation(url);
    this.observer.disclosed(artifactKey, { includeAttachment });
  }
  stop(): void {
    this.closed = true;
    this.lifetime.abort();
    this.observer.close();
  }
  async close(): Promise<void> {
    this.stop();
    await Promise.allSettled([...this.writes, this.pruning]);
    this.entries.clear();
    if (this.directory)
      await rm(await this.directory, { recursive: true, force: true });
    this.bytes = 0;
  }

  private async lookup(secret: string) {
    const entry = this.entries.get(digest(secret));
    if (!entry) throw unavailable();
    await this.check(entry);
    await entry.verifyOpen?.();
    await this.check(entry);
    return entry;
  }
  private async fromUrl(url: string) {
    const prefix = `${this.origin}/mcp-artifacts/`;
    if (!url.startsWith(prefix)) throw unavailable();
    const match =
      /^([A-Za-z0-9_-]{43})\/(page\.(?:png|jpg|webp|psd)|pages\.zip|work\.mgtshare|text\.txt|review\.(?:csv|tsv)|context\.json)$/.exec(
        url.slice(prefix.length),
      );
    if (!match) throw unavailable();
    const entry = await this.lookup(match[1]);
    if (entry.name !== match[2]) throw unavailable();
    return entry;
  }
  private check(entry: Artifact) {
    return checkMcpArtifactEntry(
      entry,
      () => !this.closed && entry.expiresAt > this.now(),
    );
  }

  private async create(
    reserved: number,
    name: Artifact["name"],
    assertAccess: Artifact["assertAccess"],
    writer: (file: string) => Promise<{ bytes: number; sha256: string }>,
    source: ArtifactSource = { bindings: [] },
    signal?: AbortSignal,
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
      signal,
    ).then((entry) => this.retainCreated(entry, source, digest(secret)));
    this.writes.add(task);
    try {
      const entry = await task;
      this.bytes += entry.size - reserved;
      return issueMcpArtifactCapability(
        this.origin,
        secret,
        entry,
        this.observer,
        "generated",
      );
    } catch (error) {
      this.bytes -= reserved;
      throw error;
    } finally {
      this.writes.delete(task);
    }
  }
  private async retainCreated(
    entry: Artifact,
    source: ArtifactSource,
    key: string,
  ) {
    entry.bindings = source.bindings;
    entry.workFileBinding = source.workFileBinding;
    entry.exchangeBinding = source.exchangeBinding;
    if (!this.retain || (!source.bindings.length && !source.exchangeBinding))
      return entry;
    try {
      entry.retainedOutputId = await this.retain(entry, () =>
        this.check(entry),
      );
      await this.check(entry);
      return entry;
    } catch (error) {
      this.entries.delete(key);
      return removeFailedMcpArtifact(
        entry.file,
        error,
        "Output retention and cleanup failed.",
      );
    }
  }
  async issueRetained(
    file: string,
    metadata: McpRetainedArtifactMetadata,
    assertAccess: () => Promise<void>,
    verifyOpen: () => Promise<void>,
  ) {
    await assertAccess();
    await verifyOpen();
    await this.prune();
    if (this.closed || this.bytes + metadata.bytes > MAX_SESSION_BYTES)
      throw unavailable();
    const secret = randomBytes(32).toString("base64url");
    this.bytes += metadata.bytes;
    let entry: Artifact;
    try {
      entry = await openBorrowedMcpArtifact(file, metadata, {
        assertAccess,
        verifyOpen,
        expiresAt: this.now() + LIFETIME_MS,
        check: (candidate) => this.check(candidate),
      });
      this.entries.set(digest(secret), entry);
    } catch (error) {
      this.bytes -= metadata.bytes;
      throw error;
    }
    return issueMcpArtifactCapability(
      this.origin,
      secret,
      entry,
      this.observer,
      "reissued",
    );
  }
  private prune(): Promise<void> {
    this.pruning ??= this.removeExpired().finally(() => {
      this.pruning = undefined;
    });
    return this.pruning;
  }
  private async removeExpired(): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > this.now() || entry.leases) continue;
      if (!entry.borrowed) await rm(entry.file, { force: true });
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
    signal?: AbortSignal,
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
        bindings: [],
        mimeType: mcpArtifactMime(name),
        size: result.bytes,
        sha256: result.sha256,
        expiresAt: this.now() + LIFETIME_MS,
        leases: 0,
        assertAccess,
        signal,
      };
      this.entries.set(key, entry);
      return entry;
    } catch (error) {
      return removeFailedMcpArtifact(
        file,
        error,
        "Output write and cleanup failed.",
      );
    }
  }
}
function digest(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}
function unavailable() {
  return new McpEditError(
    "not_found",
    "Output link is unavailable or expired. Inspect retained outputs or explicitly export again.",
  );
}
