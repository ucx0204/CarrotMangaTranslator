import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { LinkedWorkspaceRecordV1 } from "../../shared/linkedWorkspaceTypes";
import { readJsonFile, writeJsonFile } from "../libraryStore/storage";
import {
  buildLinkedMirrorFileName,
  resolvePathInside,
} from "./linkedWorkspacePaths";

/** A disposable proof that an idle connection's full startup audit is unchanged.
 * Library records, the queue and actual files remain the only data authorities.
 */
export class LinkedWorkspaceStartupCache {
  private previous: Record<string, string> = {};
  private readonly next: Record<string, string> = {};
  private readonly path: string;
  constructor(
    dataRoot: string,
    private readonly chapterPath: (workId: string, chapterId: string) => string,
    private readonly reportError: (message: string, error: unknown) => void,
  ) {
    this.path = join(dataRoot, "cache", "linked-workspace-startup-v1.json");
  }
  async load(): Promise<void> {
    try {
      const value = await readJsonFile<unknown>(this.path, null);
      if (
        !value ||
        typeof value !== "object" ||
        !("version" in value) ||
        value.version !== 1 ||
        !("records" in value)
      )
        return;
      if (
        !value.records ||
        typeof value.records !== "object" ||
        Array.isArray(value.records)
      )
        return;
      this.previous = Object.fromEntries(
        Object.entries(value.records).filter(
          ([, stamp]) =>
            typeof stamp === "string" && /^[a-f0-9]{64}$/.test(stamp),
        ),
      );
    } catch (error) {
      this.reportError(
        "Linked startup cache unavailable; running full audit",
        error,
      );
    }
  }
  matches(id: string, stamp: string | null): boolean {
    if (stamp === null || this.previous[id] !== stamp) return false;
    this.next[id] = stamp;
    return true;
  }
  remember(id: string, before: string | null, after: string | null): void {
    if (before !== null && before === after) this.next[id] = before;
  }
  async save(): Promise<void> {
    try {
      await writeJsonFile(this.path, { version: 1, records: this.next });
    } catch (error) {
      this.reportError("Linked startup cache could not be saved", error);
    }
  }
  async capture(record: LinkedWorkspaceRecordV1): Promise<string | null> {
    if (!record.destinationKind || record.organization?.error) return null;
    try {
      const files = collectAuditFiles(
        record,
        this.chapterPath(record.workId, record.chapterId),
      );
      if (!files) return null;
      // Include ancestors: changing a directory into a junction must not reuse
      // a previous audit even when its target happens to contain the same files.
      const paths = new Set([...files].map((path) => resolve(path)));
      for (const file of files) {
        let parent = dirname(resolve(file));
        while (dirname(parent) !== parent) {
          paths.add(parent);
          parent = dirname(parent);
        }
      }
      const ordered = [...paths].sort();
      const hash = createHash("sha256").update(JSON.stringify(record));
      for (let offset = 0; offset < ordered.length; offset += 32) {
        const stamps = await Promise.all(
          ordered.slice(offset, offset + 32).map(async (path) => {
            const info = await lstat(path, { bigint: true });
            if (
              info.isSymbolicLink() ||
              (!info.isFile() && !info.isDirectory())
            )
              throw new Error("Uncacheable linked path");
            // Directory content timestamps change for unrelated siblings. The
            // directory's inode/birthtime/type suffice for parent path identity.
            return [
              path,
              info.dev,
              info.ino,
              info.birthtimeNs,
              info.mode,
              ...(info.isFile() ? [info.size, info.mtimeNs, info.ctimeNs] : []),
            ].join(":");
          }),
        );
        for (const stamp of stamps) hash.update(stamp).update("\0");
      }
      return hash.digest("hex");
    } catch (error) {
      // error-policy-allow: missing/changed/linked paths require the original full audit.
      void error;
      return null;
    }
  }
}

function collectAuditFiles(
  record: LinkedWorkspaceRecordV1,
  chapterPath: string,
): Set<string> | null {
  const files = new Set([
    // Recompilation/installation invalidates the proof alongside file edits.
    __filename,
    chapterPath,
    resolvePathInside(
      record.rootPath,
      buildLinkedMirrorFileName(record.rootPath),
    ),
  ]);
  for (const id of Object.keys(record.pageRelativePaths)) {
    const source = record.sourceRelativePaths?.[id];
    const original = record.originalFingerprints?.[id];
    if (!source || !original) return null;
    files.add(original.path);
    files.add(resolvePathInside(record.rootPath, source));
    for (const artifact of Object.values(record.artifacts[id] ?? {})) {
      files.add(resolvePathInside(record.rootPath, artifact.path));
      if ("sourcePath" in artifact && artifact.sourcePath)
        files.add(artifact.sourcePath);
    }
  }
  return files;
}
