import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  backupRelativePath,
  MAX_BACKUP_FILES,
  MAX_BACKUP_JSON_BYTES,
  type BackupInventoryEntry,
} from "./policy";

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export async function regularFiles(
  root: string,
  prefix = "",
): Promise<string[]> {
  const info = await lstat(root);
  if (info.isSymbolicLink())
    throw new Error(
      "Linked folders and symbolic links cannot be included in a backup.",
    );
  if (info.isFile()) return [backupRelativePath(prefix)];
  if (!info.isDirectory()) throw new Error("Backup contains a special file.");
  const result: string[] = [];
  const entries = (await readdir(root)).sort();
  for (const name of entries) {
    result.push(
      ...(await regularFiles(
        join(root, name),
        prefix ? `${prefix}/${name}` : name,
      )),
    );
    if (result.length > MAX_BACKUP_FILES)
      throw new Error("Backup contains too many files.");
  }
  return result;
}
export async function assertFreeSpace(
  directory: string,
  bytes: number,
): Promise<void> {
  const space = await statfs(directory);
  if (space.bavail * space.bsize < bytes + 64 * 1024 ** 2)
    throw new Error("Not enough free disk space for the backup.");
}
export async function readBackupJson(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > MAX_BACKUP_JSON_BYTES
  )
    throw new Error("Invalid backup JSON file.");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
export async function copyBackupFile(
  source: string,
  target: string,
  signal: AbortSignal,
  progress?: (bytes: number) => void,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const sourceStream = createReadStream(source);
  sourceStream.on("data", (chunk: Buffer) => progress?.(chunk.length));
  await pipeline(
    sourceStream,
    createWriteStream(target, { flags: "wx", mode: 0o600 }),
    { signal },
  );
}
export async function hashBackupFile(
  root: string,
  path: string,
  signal: AbortSignal,
  progress?: (bytes: number) => void,
): Promise<BackupInventoryEntry> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(join(root, path), { signal })) {
    hash.update(chunk);
    size += chunk.length;
    progress?.(chunk.length);
  }
  return { path, size, sha256: hash.digest("hex") };
}
export function verifyBackupStream(expected: BackupInventoryEntry): Transform {
  const hash = createHash("sha256");
  let size = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > expected.size)
        return callback(new Error("Backup file exceeds its declared size."));
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      callback(
        size === expected.size && hash.digest("hex") === expected.sha256
          ? null
          : new Error("Backup checksum mismatch."),
      );
    },
  });
}
