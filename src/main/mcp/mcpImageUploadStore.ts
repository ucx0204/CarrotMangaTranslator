import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  MCP_UPLOAD_CHUNK_BYTES, MCP_UPLOAD_SESSION_BYTES, MCP_UPLOAD_LIFETIME_MS,
  McpImageUploadBeginSchema, McpImageUploadChunkSchema,
  type McpImageUploadBegin,
} from "../../shared/mcpImageUploads";
import type { McpImageFileEvidence } from "../application/mcpImageEditPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import { decodeMcpUploadPng } from "./mcpImageUploadPng";
import { imageUploadDigest, readImageUploadFile, appendImageUploadFile } from "./mcpImageUploadFiles";

type Entry = {
  id: string; owner: string; input: McpImageUploadBegin;
  files: McpImageFileEvidence[]; expiresAt: number; path?: string;
  received: number; busy: boolean; leases: number;
  ready?: { hasTransparency: boolean; selectedPixels: number | null };
  chunks: Map<number, { bytes: number; digest: string }>;
};
/** Receiving bytes is not permission to edit a page. No caller paths or URLs. */
export class McpImageUploadStore {
  private readonly entries = new Map<string, Entry>();
  private readonly requests = new Map<string, { fingerprint: string; id: string }>();
  private readonly tasks = new Set<Promise<unknown>>();
  private directory?: Promise<string>;
  private reserved = 0;
  private closed = false;
  constructor(private readonly now: () => number = Date.now) {}

  begin(owner: string, value: unknown, files: McpImageFileEvidence[], guard: () => void) {
    const input = McpImageUploadBeginSchema.parse(value);
    this.check(guard);
    const key = `${owner}:${input.requestId}`, fingerprint = hashStableValue(input);
    const previous = this.requests.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new McpEditError("invalid_edit", "Upload requestId already describes different input.");
      return Promise.resolve(this.inspect(owner, previous.id, guard));
    }
    if (this.requests.size >= 256 || this.entries.size >= 32 || this.reserved + input.bytes > MCP_UPLOAD_SESSION_BYTES)
      throw new McpEditError("editor_busy", "Upload session capacity reached (32 files / 128 MiB / 256 receipts). Discard unneeded uploads; no source file was changed.");
    const entry: Entry = {
      id: randomUUID(), owner, input, files: structuredClone(files),
      expiresAt: this.now() + MCP_UPLOAD_LIFETIME_MS, received: 0,
      busy: true, leases: 0, chunks: new Map(),
    };
    this.entries.set(entry.id, entry);
    this.requests.set(key, { fingerprint, id: entry.id });
    this.reserved += input.bytes;
    return this.track(this.create(entry, guard));
  }
  inspect(owner: string, id: string, guard: () => void) {
    return view(this.require(owner, id, guard));
  }
  chunk(owner: string, value: unknown, guard: () => void) {
    const input = McpImageUploadChunkSchema.parse(value);
    return this.exclusive(owner, input.uploadId, guard, async (entry) => {
      const bytes = Buffer.from(input.data, "base64");
      if (!bytes.length || bytes.length > MCP_UPLOAD_CHUNK_BYTES || bytes.toString("base64") !== input.data)
        throw new McpEditError("invalid_edit", "Expected canonical base64 for at most 32 KiB of actual file bytes.");
      const digest = imageUploadDigest(bytes), prior = entry.chunks.get(input.offset);
      if (prior) {
        if (prior.bytes !== bytes.length || prior.digest !== digest)
          throw new McpEditError("invalid_edit", "A repeated chunk must contain exactly the original bytes.");
        return view(entry);
      }
      if (entry.ready || input.offset !== entry.received || entry.received + bytes.length > entry.input.bytes)
        throw new McpEditError("invalid_edit", "Chunks must append at receivedBytes without gaps, overlaps or excess data.");
      await appendImageUploadFile(pathOf(entry), entry.received, bytes);
      entry.chunks.set(input.offset, { bytes: bytes.length, digest });
      entry.received += bytes.length;
      this.checkEntry(entry, guard);
      return view(entry);
    });
  }
  finish(owner: string, id: string, guard: () => void) {
    return this.exclusive(owner, id, guard, async (entry) => {
      if (entry.received !== entry.input.bytes)
        throw new McpEditError("invalid_edit", "Upload is incomplete. Resume at receivedBytes before validation.");
      const bytes = await readImageUploadFile(pathOf(entry), entry.input.bytes, entry.input.sha256);
      const { hasTransparency, selectedPixels } = decodeMcpUploadPng(bytes, entry.input);
      this.checkEntry(entry, guard);
      entry.ready = { hasTransparency, selectedPixels };
      return view(entry);
    });
  }
  /** Holds the upload against deletion through the actual consuming transaction. */
  use<T>(owner: string, id: string, guard: () => void,
    consume: (asset: { input: McpImageUploadBegin; files: McpImageFileEvidence[]; bytes: Buffer; expiresAt: number; guard: () => void }) => Promise<T>,
  ): Promise<T> {
    const entry = this.require(owner, id, guard);
    if (!entry.ready || entry.busy) throw unavailable();
    entry.leases++;
    const checked = () => this.checkEntry(entry, guard);
    const task = (async () => {
      try {
        const bytes = await readImageUploadFile(pathOf(entry), entry.input.bytes, entry.input.sha256);
        checked();
        return await consume({ input: structuredClone(entry.input), files: structuredClone(entry.files), bytes, expiresAt: entry.expiresAt, guard: checked });
      } finally {
        entry.leases--;
      }
    })();
    return this.track(task);
  }
  discard(owner: string, id: string, guard: () => void) {
    this.check(guard);
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) throw unavailable();
    if (entry.busy || entry.leases) throw new McpEditError("editor_busy", "Upload is in use; no file was removed.");
    entry.busy = true;
    return this.track((async () => {
      try {
        if (entry.path) await rm(entry.path, { force: true });
        this.entries.delete(id);
        this.reserved -= entry.input.bytes;
        this.check(guard);
        return { uploadId: id, discarded: true as const };
      } finally { entry.busy = false; }
    })());
  }
  stop() { this.closed = true; }
  async close() {
    this.stop();
    await Promise.allSettled([...this.tasks]);
    if (this.directory) await rm(await this.directory, { recursive: true, force: true });
    this.entries.clear();
    this.requests.clear();
    this.reserved = 0;
  }
  private async create(entry: Entry, guard: () => void) {
    this.directory ??= mkdtemp(join(tmpdir(), "carrot-mcp-input-"));
    try {
      entry.path = join(await this.directory, `${entry.id}.png`);
      this.checkEntry(entry, guard);
      await writeFile(entry.path, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
      this.checkEntry(entry, guard);
      return view(entry);
    } catch (error) {
      if (entry.path) await rm(entry.path, { force: true });
      this.entries.delete(entry.id);
      this.reserved -= entry.input.bytes;
      throw error;
    } finally { entry.busy = false; }
  }
  private exclusive<T>(owner: string, id: string, guard: () => void, run: (entry: Entry) => Promise<T>) {
    const entry = this.require(owner, id, guard);
    if (entry.busy || entry.leases) throw new McpEditError("editor_busy", "Upload has another active operation.");
    entry.busy = true;
    return this.track((async () => {
      try { return await run(entry); }
      finally { entry.busy = false; }
    })());
  }
  private require(owner: string, id: string, guard: () => void) {
    this.check(guard);
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) throw unavailable();
    this.checkEntry(entry, guard);
    return entry;
  }
  private checkEntry(entry: Entry, guard: () => void) {
    this.check(guard);
    if (entry.expiresAt <= this.now()) throw unavailable();
  }
  private check(guard: () => void) {
    guard();
    if (this.closed) throw unavailable();
  }
  private async track<T>(task: Promise<T>) {
    this.tasks.add(task);
    try { return await task; }
    finally { this.tasks.delete(task); }
  }
}
function view(entry: Entry) {
  const input = entry.input;
  return {
    uploadId: entry.id, chapterId: input.chapterId, pageId: input.pageId, revision: input.revision,
    purpose: input.purpose, mimeType: input.mimeType,
    status: entry.ready ? "ready" as const : "receiving" as const,
    expectedBytes: input.bytes, receivedBytes: entry.received, sha256: input.sha256,
    width: input.width, height: input.height, expiresAt: entry.expiresAt,
    chunkBytes: MCP_UPLOAD_CHUNK_BYTES,
    hasTransparency: entry.ready?.hasTransparency ?? null,
    selectedPixels: entry.ready?.selectedPixels ?? null,
  };
}
function pathOf(entry: Entry) {
  if (!entry.path) throw unavailable();
  return entry.path;
}
function unavailable() {
  return new McpEditError("not_found", "Owned image upload is unavailable, incomplete, expired or closed. No page was modified.");
}
