import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { renameWithTransientRetry } from "./libraryStore/storage";

export const REDACTION_INDEX_FILE = "manual-redaction-workspaces.json";
export const REDACTION_OBJECT_DIRECTORY = "manual-redaction-drafts";
export const MAX_REDACTION_RECORD_BYTES = 64 * 1024 * 1024;
export type RedactionDiskWriter = (
  path: string,
  bytes: Uint8Array,
) => Promise<void>;

export function redactionObjectHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function encodeRedactionRecord(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.length > MAX_REDACTION_RECORD_BYTES)
    throw new Error("가리기 초안 항목이 저장 한도를 초과했습니다.");
  return bytes;
}
export async function readRedactionRecord(path: string): Promise<Buffer> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > MAX_REDACTION_RECORD_BYTES
  )
    throw new Error("가리기 초안 항목을 안전하게 읽을 수 없습니다.");
  const bytes = await readFile(path);
  if (bytes.length > MAX_REDACTION_RECORD_BYTES)
    throw new Error("가리기 초안 항목이 저장 한도를 초과했습니다.");
  return bytes;
}
export async function redactionObjectDirectory(
  root: string,
  create = false,
): Promise<string> {
  const path = join(root, REDACTION_OBJECT_DIRECTORY);
  if (create) await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("가리기 초안 저장 폴더가 올바르지 않습니다.");
  return path;
}
export async function readRedactionObject(
  root: string,
  hash: string,
): Promise<unknown> {
  const directory = await redactionObjectDirectory(root);
  const bytes = await readRedactionRecord(join(directory, `${hash}.json`));
  if (redactionObjectHash(bytes) !== hash)
    throw new Error("가리기 초안 항목이 손상되었습니다.");
  return JSON.parse(bytes.toString("utf8"));
}
export async function writeRedactionObject(
  root: string,
  value: unknown,
  previous: string | undefined,
  persist: RedactionDiskWriter = persistRedactionRecord,
): Promise<string> {
  const bytes = encodeRedactionRecord(value);
  const hash = redactionObjectHash(bytes);
  // An unchanged previous reference was already verified when the snapshot loaded.
  if (hash === previous) return hash;
  const directory = await redactionObjectDirectory(root, true);
  const path = join(directory, `${hash}.json`);
  try {
    const existing = await readRedactionRecord(path);
    if (redactionObjectHash(existing) !== hash)
      throw new Error("가리기 초안 항목이 손상되었습니다.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await persist(path, bytes);
  }
  return hash;
}

/** Retain the existing fsync-before-rename policy and shared Windows rename retries. */
export async function persistRedactionRecord(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.manual-redaction-${randomUUID()}.tmp`,
  );
  try {
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await renameWithTransientRetry(temporary, path);
  } catch (error) {
    try {
      await rm(temporary, { force: true });
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "가리기 초안 저장과 임시 파일 정리에 실패했습니다.",
        { cause: cleanup },
      );
    }
    throw error;
  }
}
