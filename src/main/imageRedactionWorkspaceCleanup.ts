import { lstat, opendir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RedactionWorkspaceIndex } from "./imageRedactionWorkspaceIndex";
import { redactionObjectDirectory } from "./imageRedactionWorkspaceObjects";

const DAY = 24 * 60 * 60 * 1000;
const MAX_DELETIONS = 256;
const nextCleanup = new Map<string, number>();

/** Run only inside the root's read/write queue, after publishing a durable index. */
export async function maintainRedactionDraftObjects(
  root: string,
  index: RedactionWorkspaceIndex,
): Promise<void> {
  const now = Date.now();
  const key = resolve(root);
  if ((nextCleanup.get(key) ?? 0) > now) return;
  nextCleanup.delete(key);
  const oldest = nextCleanup.keys().next().value;
  if (nextCleanup.size >= 64 && oldest !== undefined)
    nextCleanup.delete(oldest);
  nextCleanup.set(key, now + DAY);
  try {
    const deleted = await cleanupRedactionDraftObjects(root, index, now);
    if (deleted >= MAX_DELETIONS) nextCleanup.set(key, now + 60_000);
  } catch (error) {
    // A cleanup fault must not turn an already-published save into a failed save.
    console.warn("Manual redaction draft cleanup deferred", error);
  }
}

/** Never follows source paths, symlinks or unknown files; legacy backups are kept. */
export async function cleanupRedactionDraftObjects(
  root: string,
  index: RedactionWorkspaceIndex,
  now = Date.now(),
): Promise<number> {
  const directory = await redactionObjectDirectory(root);
  const retained = new Set([
    ...Object.values(index.pages),
    ...Object.values(index.views).map((view) => view.object),
    index.preferences,
    index.presets,
  ]);
  let deleted = 0;
  for await (const entry of await opendir(directory)) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const object = /^([a-f0-9]{64})\.json$/.exec(entry.name);
    const temporary =
      /^\.manual-redaction-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/.test(
        entry.name,
      );
    if ((!object && !temporary) || (object && retained.has(object[1])))
      continue;
    const path = join(directory, entry.name);
    if (await removeStaleFile(path, now - DAY)) deleted++;
    if (deleted >= MAX_DELETIONS) break;
  }
  return deleted;
}

async function removeStaleFile(path: string, cutoff: number): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs >= cutoff)
      return false;
    await rm(path, { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
