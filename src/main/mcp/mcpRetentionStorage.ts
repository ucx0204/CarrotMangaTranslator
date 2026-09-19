import { join } from "node:path";
import { mkdir, lstat, readFile } from "node:fs/promises";
import { z } from "zod";
import { getLibraryRoot } from "../library";
import type { LibraryTransaction } from "../libraryStore/libraryTransaction";
import {
  assertPathWithinRootWithoutSymlinks,
  writeDurableJsonFile,
} from "../libraryStore/libraryTransactionStorage";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  RetentionIndexSchema,
  MCP_RETENTION_CAPACITY,
  MCP_RETENTION_BYTES,
  type RetentionIndex,
  type RetentionEntry,
} from "./mcpRetentionRecords";

export type McpRetentionCodec = {
  seal: (value: unknown) => Promise<unknown>;
  open: (value: unknown) => Promise<unknown>;
};
/** All writes join an existing native library transaction under the native write lock.
 * The index and record metadata are encrypted and bound to the current data profile. */
export class McpRetentionStorage {
  constructor(
    readonly codec: McpRetentionCodec,
    readonly now = Date.now,
  ) {}
  async path(id?: string, asset?: string): Promise<string> {
    if (id) z.string().uuid().parse(id);
    if (asset)
      z.string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(asset);
    const path = id
      ? join(
          getLibraryRoot(),
          ".mcp-retained",
          id,
          asset ? `${asset}.bin` : "record.json",
        )
      : join(getLibraryRoot(), ".mcp-retained", "index.json");
    await assertPathWithinRootWithoutSymlinks(getLibraryRoot(), path, {
      allowMissingTarget: true,
    });
    return path;
  }
  async index(): Promise<RetentionIndex> {
    const value = await this.read(await this.path(), true);
    return value === null
      ? { version: 1, entries: [] }
      : RetentionIndexSchema.parse(value);
  }
  async owned(owner: string, id: string, kind?: RetentionEntry["kind"]) {
    const index = await this.index();
    const entry = index.entries.find(
      (item) => item.id === id && item.owner === owner,
    );
    if (
      !entry ||
      entry.expiresAt <= this.now() ||
      (kind && entry.kind !== kind)
    )
      throw new McpEditError(
        "not_found",
        "Retained record is missing, expired or owned by another connection.",
      );
    return { index, entry };
  }
  async record(id: string): Promise<unknown> {
    return this.read(await this.path(id), false);
  }
  async stageIndex(transaction: LibraryTransaction, index: RetentionIndex) {
    const checked = RetentionIndexSchema.parse(index);
    if (
      checked.entries.reduce((sum, entry) => sum + entry.bytes, 0) >
      MCP_RETENTION_BYTES
    )
      throw new McpEditError(
        "editor_busy",
        "Retained storage is full (1 GiB). Discard owned records explicitly; no page change was saved.",
      );
    await transaction.stageJsonReplacement(
      await this.path(),
      await this.codec.seal(checked),
    );
  }
  async stageRecord(
    transaction: LibraryTransaction,
    id: string,
    value: unknown,
  ) {
    const path = await this.path(id);
    const old = await lstat(path);
    if (!old.isFile() || old.isSymbolicLink())
      throw new Error("Invalid retained record file.");
    const sealed = await this.codec.seal(value);
    const bytes = Buffer.byteLength(JSON.stringify(sealed, null, 2)) + 1;
    const index = await this.index();
    const entry = index.entries.find((item) => item.id === id);
    if (!entry) throw new Error("Retained record has no index entry.");
    entry.bytes += bytes - old.size;
    await transaction.stageJsonReplacement(path, sealed);
    await this.stageIndex(transaction, index);
  }
  async create(transaction: LibraryTransaction, id: string) {
    const base = join(getLibraryRoot(), ".mcp-retained");
    await this.path(id);
    await mkdir(base, { recursive: true, mode: 0o700 });
    return transaction.createPublishedDirectory(join(base, id));
  }
  async writeRecord(directory: string, value: unknown): Promise<number> {
    const sealed = await this.codec.seal(value);
    const bytes = Buffer.byteLength(JSON.stringify(sealed, null, 2)) + 1;
    if (bytes > 8 * 1024 * 1024)
      throw new Error("Retained metadata exceeds 8 MiB.");
    await writeDurableJsonFile(join(directory, "record.json"), sealed);
    return bytes;
  }
  async prune(transaction: LibraryTransaction, index: RetentionIndex) {
    const expired = index.entries.filter(
      (entry) => entry.expiresAt <= this.now(),
    );
    for (const entry of expired) await this.retire(transaction, entry.id);
    const next = {
      ...index,
      entries: index.entries.filter((entry) => entry.expiresAt > this.now()),
    };
    if (next.entries.length >= MCP_RETENTION_CAPACITY)
      throw new McpEditError(
        "editor_busy",
        "Retained history contains 256 records. Discard owned records before another edit.",
      );
    return next;
  }
  async retire(transaction: LibraryTransaction, id: string) {
    await this.path(id);
    await transaction.retireDirectory(
      join(getLibraryRoot(), ".mcp-retained", id),
    );
  }
  private async read(path: string, missing: boolean): Promise<unknown | null> {
    try {
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 8 * 1024 * 1024
      )
        throw new Error("Invalid or oversized retained metadata.");
      const text = await readFile(path, "utf8");
      if (Buffer.byteLength(text) > 8 * 1024 * 1024)
        throw new Error("Retained metadata grew while reading.");
      return await this.codec.open(JSON.parse(text));
    } catch (error) {
      if (
        missing &&
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return null;
      throw error;
    }
  }
}
