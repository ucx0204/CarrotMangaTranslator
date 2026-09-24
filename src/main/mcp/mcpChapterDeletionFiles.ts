import {
  TRANSACTION_OWNER_MARKER,
  type LibraryTransaction,
} from "../libraryStore/libraryTransaction";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, opendir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { getLibraryRoot } from "../library";
import { normalizeShareRelativePath } from "../libraryStore/zipSafety";
import {
  assertPathWithinRootWithoutSymlinks,
  pathState,
  sha256Bytes,
  writeDurableJsonFile,
} from "../libraryStore/libraryTransactionStorage";
import { inspectRetainedFile } from "./mcpRetentionEvidence";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import {
  ChapterDeletionTreeSchema,
  RecoveryDirectoryTreeSchema,
  type ChapterDeletionTree,
  type ChapterDeletionRecord,
} from "../application/mcpChapterDeletionState";
import {
  MCP_CHAPTER_DELETION_BYTES,
  MCP_CHAPTER_DELETION_ENTRIES,
} from "../../shared/mcpChapterDeletion";

const CHUNK_BYTES = 1024 * 1024;
const ENVELOPE_BYTES = 3 * CHUNK_BYTES;
const payloadSchema = z
  .object({ chunk: z.string().max(2 * CHUNK_BYTES) })
  .strict();

/** Native paths only. The transport receives totals, never this file inventory. */
export async function captureChapterDeletionTree(
  directory: string,
  guard: () => void,
  metadata: "chapter.json" | "work.json" | null = "chapter.json",
): Promise<ChapterDeletionTree> {
  return captureDeletionTree(directory, guard, metadata);
}

/** Only an actual native transaction handle can identify the separately validated root marker. */
export async function captureStagedDeletionTree(
  staged: Awaited<ReturnType<LibraryTransaction["createPublishedDirectory"]>>,
  guard: () => void,
  metadata: "chapter.json" | "work.json" | null = "chapter.json",
) {
  guard();
  const owned = await staged.verifyOwnership();
  if (
    owned.directory !== staged.stagingDirectory ||
    owned.marker !== TRANSACTION_OWNER_MARKER
  )
    throw new Error(
      "Recovery staging ownership does not match its native handle.",
    );
  const tree = await captureDeletionTree(
    owned.directory,
    guard,
    metadata,
    owned.marker,
  );
  await staged.verifyOwnership();
  guard();
  return tree;
}

async function captureDeletionTree(
  directory: string,
  guard: () => void,
  metadata: "chapter.json" | "work.json" | null,
  ownedMarker?: string,
): Promise<ChapterDeletionTree> {
  const tree: ChapterDeletionTree = { directories: [], files: [] };
  const pending = [""];
  let total = 0;
  for (const parent of pending) {
    guard();
    const absolute = join(directory, parent);
    await assertPathWithinRootWithoutSymlinks(getLibraryRoot(), absolute);
    if ((await pathState(absolute)) !== "directory")
      throw new Error("Chapter recovery requires ordinary directories.");
    for await (const entry of await opendir(absolute)) {
      guard();
      const path = parent ? `${parent}/${entry.name}` : entry.name;
      assertRecoveryRelativePath(path);
      if (isOwnedRecoveryMarker(path, ownedMarker)) continue;
      if (
        tree.files.length + tree.directories.length >=
        MCP_CHAPTER_DELETION_ENTRIES
      )
        throw new Error(
          "Chapter recovery has more than 2000 filesystem entries.",
        );
      if (entry.isSymbolicLink())
        throw new Error("Chapter recovery does not follow links.");
      if (entry.isDirectory()) {
        tree.directories.push(path);
        pending.push(path);
        continue;
      }
      const evidence = await inspectRetainedFile(join(directory, path));
      total += evidence.bytes;
      if (total > MCP_CHAPTER_DELETION_BYTES)
        throw new Error("Chapter recovery exceeds 256 MiB.");
      tree.files.push({ path, ...evidence });
    }
  }
  tree.directories.sort();
  tree.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  validateChapterDeletionTree(tree, metadata);
  return tree;
}

export function validateChapterDeletionTree(
  tree: ChapterDeletionTree,
  metadata: "chapter.json" | "work.json" | null = "chapter.json",
) {
  (metadata === null
    ? RecoveryDirectoryTreeSchema
    : ChapterDeletionTreeSchema
  ).parse(tree);
  const paths = [...tree.directories, ...tree.files.map((file) => file.path)];
  const names = new Set<string>();
  for (const path of paths) {
    assertRecoveryRelativePath(path);
    if (path.toLowerCase() === TRANSACTION_OWNER_MARKER)
      throw new Error(
        "Recovery inventory contains a reserved transaction owner marker.",
      );
    const key = path.toLowerCase();
    if (names.has(key)) throw new Error("Chapter recovery paths overlap.");
    names.add(key);
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (path.includes("/") && !tree.directories.includes(parent))
      throw new Error("Chapter recovery is missing a parent directory.");
  }
  if (metadata !== null && !tree.files.some((file) => file.path === metadata))
    throw new Error("Chapter recovery metadata is missing.");
}
function assertRecoveryRelativePath(path: string) {
  if (
    normalizeShareRelativePath(path, "Invalid recovery path.") !== path ||
    /[<>:"|?*\u0000-\u001f]/u.test(path) ||
    path.split("/").length > 32 ||
    path
      .split("/")
      .some(
        (part) =>
          /[. ]$/u.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
      )
  )
    throw new Error("Chapter recovery path is not portable and unambiguous.");
}

/** Small independently encrypted chunks reuse the existing OS/profile codec.
 * No plaintext chapter JSON, story memory, artwork or private paths are duplicated in retained assets. */
export async function retainChapterDeletionFiles(
  storage: McpRetentionStorage,
  directory: string,
  staging: string,
  tree: ChapterDeletionTree,
  guard: () => void,
  metadata: "chapter.json" | "work.json" | null = "chapter.json",
) {
  validateChapterDeletionTree(tree, metadata);
  const copied = new Set<string>();
  const parts: string[][] = [];
  let bytes = 0;
  for (const file of tree.files) {
    guard();
    const source = join(directory, file.path);
    await assertPathWithinRootWithoutSymlinks(getLibraryRoot(), source);
    const digest = createHash("sha256");
    const chunks: string[] = [];
    let count = 0;
    for await (const value of createReadStream(source, {
      highWaterMark: CHUNK_BYTES,
    })) {
      guard();
      const chunk = Buffer.from(value);
      count += chunk.length;
      if (count > file.bytes)
        throw new Error("Chapter source grew during retention.");
      digest.update(chunk);
      const hash = sha256Bytes(chunk);
      chunks.push(hash);
      if (!copied.has(hash)) {
        const sealed = await storage.codec.seal({
          chunk: chunk.toString("base64"),
        });
        const path = join(staging, `${hash}.bin`);
        await writeDurableJsonFile(path, sealed);
        bytes += (await lstat(path)).size;
        copied.add(hash);
      }
    }
    if (count !== file.bytes || digest.digest("hex") !== file.sha256)
      throw new Error("Chapter source changed while retaining recovery.");
    parts.push(chunks);
  }
  guard();
  return { parts, bytes };
}

async function readRecoveryChunk(
  storage: McpRetentionStorage,
  id: string,
  hash: string,
  guard: () => void,
  stagedSource?: string,
) {
  guard();
  const path = stagedSource
    ? join(stagedSource, `${hash}.bin`)
    : await storage.path(id, hash);
  await assertPathWithinRootWithoutSymlinks(getLibraryRoot(), path);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > ENVELOPE_BYTES)
    throw new Error("Invalid encrypted chapter asset.");
  const raw = await readFile(path, "utf8");
  if (Buffer.byteLength(raw) > ENVELOPE_BYTES)
    throw new Error("Encrypted chapter asset grew.");
  const value = payloadSchema.parse(await storage.codec.open(JSON.parse(raw)));
  const bytes = Buffer.from(value.chunk, "base64");
  if (
    bytes.length > CHUNK_BYTES ||
    bytes.toString("base64") !== value.chunk ||
    sha256Bytes(bytes) !== hash
  )
    throw new Error("Encrypted chapter asset is inconsistent.");
  guard();
  return bytes;
}

/** Reverification and restoration use identical decoding/digest checks; only staged output is optional. */
export async function verifyChapterDeletionFiles(
  storage: McpRetentionStorage,
  record: Pick<ChapterDeletionRecord, "id" | "tree" | "parts">,
  guard: () => void,
  destination?: string,
  stagedSource?: string,
  metadata: "chapter.json" | "work.json" | null = "chapter.json",
) {
  validateChapterDeletionTree(record.tree, metadata);
  if (destination)
    for (const path of record.tree.directories) {
      guard();
      await mkdir(join(destination, path), { recursive: true });
    }
  for (const index of record.tree.files.keys())
    await verifyRecoveredFile(
      storage,
      record,
      index,
      guard,
      destination,
      stagedSource,
    );
  guard();
}

async function verifyRecoveredFile(
  storage: McpRetentionStorage,
  record: Pick<ChapterDeletionRecord, "id" | "tree" | "parts">,
  index: number,
  guard: () => void,
  destination?: string,
  stagedSource?: string,
) {
  const handle = destination
    ? await open(join(destination, record.tree.files[index].path), "wx", 0o600)
    : undefined;
  try {
    for await (const bytes of recoveryFileChunks(
      storage,
      record,
      index,
      guard,
      stagedSource,
    ))
      await handle?.writeFile(bytes);
    await handle?.sync();
  } finally {
    await handle?.close();
  }
}

/** One verified stream is shared by restoration and bounded native-metadata parsing. */
async function* recoveryFileChunks(
  storage: McpRetentionStorage,
  record: Pick<ChapterDeletionRecord, "id" | "tree" | "parts">,
  index: number,
  guard: () => void,
  stagedSource?: string,
) {
  const file = record.tree.files[index];
  const digest = createHash("sha256");
  let count = 0;
  guard();
  for (const hash of record.parts[index]) {
    const bytes = await readRecoveryChunk(
      storage,
      record.id,
      hash,
      guard,
      stagedSource,
    );
    count += bytes.length;
    if (count > file.bytes)
      throw new Error("Recovered file exceeds its reviewed length.");
    digest.update(bytes);
    yield bytes;
  }
  if (count !== file.bytes || digest.digest("hex") !== file.sha256)
    throw new Error(
      "Recovered chapter bytes do not match the reviewed source.",
    );
  guard();
}

/** Native callers select a recorded metadata name, never a transport-supplied path. */
export async function readRecoveryMetadata(
  storage: McpRetentionStorage,
  record: Pick<ChapterDeletionRecord, "id" | "tree" | "parts">,
  path: string,
  guard: () => void,
  stagedSource?: string,
): Promise<unknown> {
  assertRecoveryRelativePath(path);
  const index = record.tree.files.findIndex((file) => file.path === path);
  if (index < 0)
    throw new Error("Recovery metadata is absent from the recorded tree.");
  if (record.tree.files[index].bytes > 4 * 1024 * 1024)
    throw new Error("Recovery JSON exceeds 4 MiB.");
  const chunks: Buffer[] = [];
  for await (const bytes of recoveryFileChunks(
    storage,
    record,
    index,
    guard,
    stagedSource,
  ))
    chunks.push(bytes);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isOwnedRecoveryMarker(path: string, ownedMarker: string | undefined) {
  if (path.toLowerCase() !== TRANSACTION_OWNER_MARKER) return false;
  if (path !== ownedMarker)
    throw new Error(
      "Recovery source contains a reserved transaction owner marker.",
    );
  return true;
}

/** Native restoration of one previously verified archived file; never a public file reader. */
export async function readRecoveryFileBytes(
  storage: McpRetentionStorage,
  record: Pick<ChapterDeletionRecord, "id" | "tree" | "parts">,
  index: number,
  guard: () => void,
) {
  const file = record.tree.files[index];
  if (!file || file.bytes > 128 * 1024 * 1024)
    throw new Error("Invalid recovery file size.");
  const chunks: Buffer[] = [];
  for await (const bytes of recoveryFileChunks(storage, record, index, guard))
    chunks.push(bytes);
  return Buffer.concat(chunks, file.bytes);
}
