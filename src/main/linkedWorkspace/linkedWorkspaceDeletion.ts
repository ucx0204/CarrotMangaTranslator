import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { LinkedWorkspaceRecordV1 } from "../../shared/linkedWorkspaceTypes";
import {
  isPathInside,
  readJsonFile,
  writeJsonFile,
} from "../libraryStore/storage";
import { fingerprintBuffer, fingerprintFile } from "./linkedWorkspaceFiles";
import {
  buildLinkedMirrorFileName,
  resolvePathInside,
} from "./linkedWorkspacePaths";

const journalSchema = z
  .object({
    id: z.string().uuid(),
    chapterIds: z.array(z.string().uuid()),
    recordIds: z.array(z.string().uuid()),
    emptyParents: z.array(z.string()).optional(),
    files: z.array(
      z
        .object({
          root: z.string(),
          path: z.string(),
          staged: z.string(),
          preserveRoot: z.boolean().optional(),
          sha256: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional(),
          replacement: z.unknown().optional(),
        })
        .strict(),
    ),
  })
  .strict();
type Journal = z.infer<typeof journalSchema>;
type OwnedFile = { path: string; sha256: string };

function ownedFiles(record: LinkedWorkspaceRecordV1): OwnedFile[] {
  const artifacts = Object.values(record.artifacts).flatMap((entry) =>
    Object.values(entry),
  );
  const originals = Object.entries(record.sourceRelativePaths ?? {}).flatMap(
    ([id, path]) => {
      const fingerprint = record.sourceFingerprints[id];
      return path.startsWith("originals/") && fingerprint
        ? [{ path, sha256: fingerprint.sha256 }]
        : [];
    },
  );
  return [...artifacts, ...originals];
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Only root-owned macOS system aliases may precede an otherwise plain path. */
export function isTrustedDarwinSystemAlias(
  path: string,
  canonicalPath: string,
  platform: NodeJS.Platform,
  ownerUid: number,
): boolean {
  return (
    platform === "darwin" &&
    ownerUid === 0 &&
    ["/var", "/tmp", "/etc"].includes(path) &&
    canonicalPath === `/private${path}`
  );
}

/** Refuse user junctions/symlinks in every component, including custom-root ancestors. */
async function assertPlainPath(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    if (await exists(current)) {
      const entry = await lstat(current);
      if (
        entry.isSymbolicLink() &&
        !isTrustedDarwinSystemAlias(
          current,
          await realpath(current),
          process.platform,
          entry.uid,
        )
      )
        throw new Error(`연결된 경로는 자동 삭제할 수 없습니다: ${current}`);
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function planDeletion(
  records: LinkedWorkspaceRecordV1[],
  all: LinkedWorkspaceRecordV1[],
  removeCustom: boolean,
  dataRoot: string,
): Promise<Journal> {
  const id = randomUUID();
  const deleting = new Set(records.map((record) => record.id));
  const protectedPaths = new Set(
    all
      .filter((record) => !deleting.has(record.id))
      .flatMap((record) =>
        ownedFiles(record).map((file) =>
          resolvePathInside(record.rootPath, file.path).toLowerCase(),
        ),
      ),
  );
  const files: Journal["files"] = [];
  for (const path of await protectedMirrorPaths(records))
    protectedPaths.add(path.toLowerCase());
  const seen = new Set<string>();
  for (const record of records.filter(
    (entry) => entry.destinationKind === "managed" || removeCustom,
  )) {
    await assertPlainPath(record.rootPath);
    for (const file of ownedFiles(record)) {
      const path = resolvePathInside(record.rootPath, file.path);
      if (
        seen.has(path.toLowerCase()) ||
        protectedPaths.has(path.toLowerCase())
      )
        continue;
      seen.add(path.toLowerCase());
      await assertPlainPath(path);
      if (!(await exists(path))) continue;
      // Files edited or replaced outside the app are not ours to remove.
      if ((await fingerprintFile(path)).sha256 !== file.sha256) continue;
      files.push({
        root: record.rootPath,
        preserveRoot: record.destinationKind !== "managed",
        path,
        staged: `${path}.manga-delete-${id}`,
        sha256: file.sha256,
      });
    }
    const mirror = await planMirror(record, records, seen, id);
    if (mirror) files.push(mirror);
  }
  return {
    id,
    chapterIds: records.map((record) => record.chapterId),
    recordIds: records.map((record) => record.id),
    emptyParents: records
      .filter(
        (record) =>
          record.destinationKind === "managed" &&
          isPathInside(join(dataRoot, "results"), record.rootPath) &&
          dirname(record.rootPath) !== join(dataRoot, "results"),
      )
      .map((record) => dirname(record.rootPath)),
    files,
  };
}

async function planMirror(
  record: LinkedWorkspaceRecordV1,
  records: LinkedWorkspaceRecordV1[],
  seen: Set<string>,
  id: string,
): Promise<Journal["files"][number] | null> {
  const path = resolvePathInside(
    record.rootPath,
    buildLinkedMirrorFileName(record.rootPath),
  );
  if (seen.has(path.toLowerCase())) return null;
  seen.add(path.toLowerCase());
  await assertPlainPath(path);
  if (!(await exists(path))) return null;
  const raw = await readFile(path, "utf8");
  const mirror = JSON.parse(raw) as Record<string, unknown> | null;
  if (!mirror || mirror.schemaVersion !== 1 || !Array.isArray(mirror.chapters))
    return null;
  const ids = new Set(records.map((entry) => entry.chapterId));
  const chapters = mirror.chapters.filter(
    (chapter: { id?: string }) => !chapter.id || !ids.has(chapter.id),
  );
  if (chapters.length === mirror.chapters.length) return null;
  return {
    root: record.rootPath,
    preserveRoot: record.destinationKind !== "managed",
    path,
    staged: `${path}.manga-delete-${id}`,
    sha256: fingerprintBuffer(Buffer.from(raw)),
    ...(chapters.length ? { replacement: { ...mirror, chapters } } : {}),
  };
}

function journalPath(dataRoot: string, id: string): string {
  return join(dataRoot, "linked-deletions", `${id}.json`);
}

async function protectedMirrorPaths(
  records: LinkedWorkspaceRecordV1[],
): Promise<string[]> {
  const ids = new Set(records.map((record) => record.chapterId));
  const paths: string[] = [];
  for (const root of new Set(records.map((record) => record.rootPath))) {
    const path = resolvePathInside(root, buildLinkedMirrorFileName(root));
    await assertPlainPath(path);
    const mirror = await readJsonFile<{
      chapters?: { id: string; pages?: unknown[] }[];
    } | null>(path, null);
    for (const chapter of mirror?.chapters ?? []) {
      if (ids.has(chapter.id)) continue;
      paths.push(
        ...(chapter.pages ?? [])
          .flatMap(mirrorPagePaths)
          .map((file) => resolvePathInside(root, file)),
      );
    }
  }
  return paths;
}

function mirrorPagePaths(page: unknown): string[] {
  if (!page || typeof page !== "object") return [];
  return ["source", "result", "inpainted", "mask"].flatMap((key) => {
    const artifact = (page as Record<string, unknown>)[key];
    return artifact &&
      typeof artifact === "object" &&
      "path" in artifact &&
      typeof artifact.path === "string"
      ? [artifact.path]
      : [];
  });
}

async function restore(journal: Journal): Promise<void> {
  for (const file of [...journal.files].reverse()) {
    if (!(await exists(file.staged))) continue;
    await assertPlainPath(file.path);
    if (await exists(file.path))
      throw new Error(`삭제 복구 대상에 다른 파일이 있습니다: ${file.path}`);
    await rename(file.staged, file.path);
  }
}

async function pruneEmpty(
  directory: string,
  root: string,
  preserveRoot = false,
): Promise<void> {
  let current = directory;
  while (true) {
    if (preserveRoot && current === resolve(root)) return;
    await assertPlainPath(current);
    try {
      await rmdir(current);
    } catch (error) {
      if (
        ["ENOTEMPTY", "EEXIST"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        return;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current === resolve(root)) return;
    current = dirname(current);
  }
}

async function finish(journal: Journal): Promise<void> {
  for (const file of journal.files) {
    await assertPlainPath(file.path);
    if (file.replacement !== undefined) {
      const existing = await readJsonFile<unknown>(file.path, null);
      if (
        existing !== null &&
        JSON.stringify(existing) !== JSON.stringify(file.replacement)
      )
        throw new Error(`삭제 완료 대상에 다른 파일이 있습니다: ${file.path}`);
      await writeJsonFile(file.path, file.replacement);
    }
    if (await exists(file.staged)) await unlink(file.staged);
  }
  for (const file of journal.files)
    await pruneEmpty(dirname(file.path), file.root, file.preserveRoot);
  for (const directory of new Set(journal.emptyParents))
    await pruneEmpty(directory, directory);
}

export async function deleteLinkedWorkspaceFiles<T>(options: {
  dataRoot: string;
  records: LinkedWorkspaceRecordV1[];
  allRecords: LinkedWorkspaceRecordV1[];
  removeCustom: boolean;
  deleteLibrary: () => Promise<T>;
  forgetRecords: (ids: string[]) => Promise<void>;
}): Promise<T> {
  const journal = await planDeletion(
    options.records,
    options.allRecords,
    options.removeCustom,
    options.dataRoot,
  );
  const path = journalPath(options.dataRoot, journal.id);
  await mkdir(dirname(path), { recursive: true });
  await writeJsonFile(path, journal);
  let committed = false;
  try {
    for (const file of journal.files) {
      await assertPlainPath(file.path);
      await rename(file.path, file.staged);
      if (
        file.sha256 &&
        (await fingerprintFile(file.staged)).sha256 !== file.sha256
      )
        throw new Error(`삭제 준비 중 파일이 변경되었습니다: ${file.path}`);
    }
    const result = await options.deleteLibrary();
    committed = true;
    await options.forgetRecords(journal.recordIds);
    await finish(journal);
    await unlink(path);
    return result;
  } catch (error) {
    if (!committed) {
      try {
        await restore(journal);
        await unlink(path);
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          "삭제 실패 후 출력물 복구가 필요합니다.",
          { cause: recoveryError },
        );
      }
    }
    throw error;
  }
}

export async function recoverLinkedWorkspaceDeletions(options: {
  dataRoot: string;
  chapterExists: (ids: string[]) => Promise<boolean>;
  forgetRecords: (ids: string[]) => Promise<void>;
}): Promise<void> {
  const directory = join(options.dataRoot, "linked-deletions");
  if (!(await exists(directory))) return;
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    const path = join(directory, name);
    const journal = journalSchema.parse(await readJsonFile(path, null));
    for (const file of journal.files) {
      if (
        file.staged !== `${file.path}.manga-delete-${journal.id}` ||
        !isPathInside(file.root, file.path) ||
        resolve(file.root) === resolve(file.path)
      )
        throw new Error("삭제 복구 경로가 올바르지 않습니다.");
    }
    if (await options.chapterExists(journal.chapterIds)) await restore(journal);
    else {
      await options.forgetRecords(journal.recordIds);
      await finish(journal);
    }
    await unlink(path);
  }
}
