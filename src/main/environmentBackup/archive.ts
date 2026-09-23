import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import * as yazl from "yazl";
import * as yauzl from "yauzl";
import { assertFreeSpace, verifyBackupStream } from "./files";
import {
  assertBackupPayloadPath,
  backupManifestSchema,
  backupRelativePath,
  MAX_BACKUP_BYTES,
  MAX_BACKUP_FILES,
  MAX_BACKUP_JSON_BYTES,
  type BackupManifest,
} from "./policy";

export async function writeBackupArchive(
  root: string,
  target: string,
  manifest: BackupManifest,
  signal: AbortSignal,
): Promise<void> {
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  if (manifestBytes.length > MAX_BACKUP_JSON_BYTES)
    throw new Error("Backup manifest is too large.");
  await assertFreeSpace(dirname(target), manifest.summary.bytes);
  const temporary = `${target}.${randomUUID()}.partial`;
  const zip = new yazl.ZipFile();
  const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  zip.on("error", (error) => output.destroy(error));
  const completion = pipeline(zip.outputStream, output, { signal }).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    zip.addBuffer(manifestBytes, "manifest.json");
    for (const entry of manifest.files) {
      signal.throwIfAborted();
      zip.addFile(join(root, entry.path), entry.path);
    }
    zip.end({
      forceZip64Format: true,
      comment: "Carrot environment backup v1",
    });
    const result = await completion;
    if (!result.ok) throw result.error;
    signal.throwIfAborted();
    await rename(temporary, target);
  } catch (error) {
    output.destroy();
    await completion;
    await unlink(temporary).catch((cleanupError: NodeJS.ErrnoException) => {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
}

async function archiveEntries(
  zip: yauzl.ZipFile,
  signal: AbortSignal,
): Promise<Map<string, yauzl.Entry>> {
  const entries = new Map<string, yauzl.Entry>();
  const folded = new Set<string>();
  let total = 0;
  for await (const entry of zip.eachEntry()) {
    signal.throwIfAborted();
    const path = backupRelativePath(entry.fileName);
    const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
    if (path.endsWith("/") || (mode && mode !== 0x8000) || entry.isEncrypted())
      throw new Error("Backup contains a link, directory or encrypted entry.");
    if (folded.has(path.toLowerCase()))
      throw new Error("Duplicate backup path.");
    folded.add(path.toLowerCase());
    entries.set(path, entry);
    total += entry.uncompressedSize;
    if (entries.size > MAX_BACKUP_FILES + 1 || total > MAX_BACKUP_BYTES)
      throw new Error("Backup exceeds the supported size.");
  }
  return entries;
}

async function readManifest(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry | undefined,
): Promise<BackupManifest> {
  if (!entry || entry.uncompressedSize > MAX_BACKUP_JSON_BYTES)
    throw new Error("Backup manifest is missing or too large.");
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > MAX_BACKUP_JSON_BYTES) {
      stream.destroy();
      throw new Error("Backup manifest is too large.");
    }
    chunks.push(chunk);
  }
  return backupManifestSchema.parse(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
  );
}

function validateInventory(
  manifest: BackupManifest,
  entries: Map<string, yauzl.Entry>,
): void {
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of manifest.files) {
    assertBackupPayloadPath(file.path);
    if (file.path.endsWith(".json") && file.size > MAX_BACKUP_JSON_BYTES)
      throw new Error("Backup JSON document is too large.");
    if (
      paths.has(file.path.toLowerCase()) ||
      entries.get(file.path)?.uncompressedSize !== file.size
    )
      throw new Error("Backup inventory does not match the archive.");
    paths.add(file.path.toLowerCase());
    bytes += file.size;
  }
  if (
    entries.size !== paths.size + 1 ||
    bytes !== manifest.summary.bytes ||
    !paths.has("portable-settings.json")
  )
    throw new Error("Incomplete backup inventory.");
}

export async function extractBackupArchive(options: {
  archive: string;
  root: string;
  signal: AbortSignal;
  progress: (current: number, total: number) => void;
}): Promise<BackupManifest> {
  const { archive, root, signal, progress } = options;
  const zip = await yauzl.openPromise(archive, {
    autoClose: false,
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  try {
    const entries = await archiveEntries(zip, signal);
    const manifest = await readManifest(zip, entries.get("manifest.json"));
    validateInventory(manifest, entries);
    await assertFreeSpace(root, manifest.summary.bytes * 2);
    let current = 0;
    for (const file of manifest.files) {
      signal.throwIfAborted();
      const entry = entries.get(file.path);
      if (!entry) throw new Error("Missing backup file.");
      const target = join(root, file.path);
      await mkdir(dirname(target), { recursive: true });
      const source = await zip.openReadStreamPromise(entry);
      await pipeline(
        source,
        verifyBackupStream(file),
        createWriteStream(target, { flags: "wx", mode: 0o600 }),
        { signal },
      );
      current += file.size;
      progress(current, manifest.summary.bytes);
    }
    return manifest;
  } finally {
    zip.close();
  }
}
