import { validateBackupUserStores } from "./validate";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppPaths } from "../appPaths";
import type {
  BackupProgress,
  BackupUiPreferences,
} from "../../shared/environmentBackup";
import { writeJsonFile } from "../libraryStore/storage";
import {
  BACKUP_SOURCE_NAMES,
  backupManifestSchema,
  MAX_BACKUP_BYTES,
  type BackupManifest,
} from "./policy";
import {
  assertFreeSpace,
  copyBackupFile,
  exists,
  hashBackupFile,
  regularFiles,
} from "./files";
import { exportPortableSettings } from "./settings";
import { relocateBackupLibrary } from "./library";
import { relocateBackupRedaction } from "./redaction";

export async function copyCategories(
  source: string,
  target: string,
  names: readonly string[],
  signal: AbortSignal,
  progress?: BackupProgress,
): Promise<void> {
  const files: string[] = [];
  for (const name of names) {
    let ancestor = source;
    for (const part of ["", ...name.split("/")]) {
      ancestor = join(ancestor, part);
      if ((await exists(ancestor)) && (await lstat(ancestor)).isSymbolicLink())
        throw new Error("Linked data folders cannot be backed up.");
    }
    if (await exists(join(source, name)))
      files.push(...(await regularFiles(join(source, name), name)));
  }
  let bytes = 0;
  for (const path of files) bytes += (await lstat(join(source, path))).size;
  if (bytes > MAX_BACKUP_BYTES)
    throw new Error("Environment exceeds the supported backup size.");
  await assertFreeSpace(target, bytes * 2);
  let current = 0;
  progress?.(current, bytes, "backup-copying");
  for (const path of files) {
    signal.throwIfAborted();
    await copyBackupFile(
      join(source, path),
      join(target, path),
      signal,
      (size) => {
        current += size;
        progress?.(current, bytes, "backup-copying");
      },
    );
  }
}

export async function linkedConnectionHints(root: string): Promise<string[]> {
  const path = join(root, "linked-workspaces.json");
  if (!(await exists(path))) return [];
  const registry = JSON.parse(await readFile(path, "utf8")) as {
    records: { rootPath?: string }[];
  };
  return registry.records.map((entry) => entry.rootPath ?? "").filter(Boolean);
}

export async function captureEnvironment(
  root: string,
  options: {
    paths: AppPaths;
    appVersion: string;
    ui: BackupUiPreferences;
    signal: AbortSignal;
    progress: BackupProgress;
  },
): Promise<{ root: string; manifest: BackupManifest }> {
  const { paths, signal, progress } = options;
  await copyCategories(
    paths.dataRoot,
    root,
    BACKUP_SOURCE_NAMES,
    signal,
    progress,
  );
  progress(0, 0, "backup-verifying");
  await writeJsonFile(
    join(root, "portable-settings.json"),
    await exportPortableSettings(paths),
  );
  const summary = await relocateBackupLibrary(root, await regularFiles(root));
  await relocateBackupRedaction(root);
  await validateBackupUserStores(root);
  const files = await regularFiles(root);
  const inventory = [];
  let total = 0,
    current = 0;
  for (const path of files) total += (await lstat(join(root, path))).size;
  progress(current, total, "backup-verifying");
  for (const path of files) {
    inventory.push(
      await hashBackupFile(root, path, signal, (size) => {
        current += size;
        progress(current, total, "backup-verifying");
      }),
    );
  }
  const manifest = backupManifestSchema.parse({
    format: "carrot-environment-backup",
    version: 1,
    appVersion: options.appVersion,
    createdAt: new Date().toISOString(),
    ui: options.ui,
    connections: await linkedConnectionHints(paths.dataRoot),
    files: inventory,
    summary: {
      ...summary,
      bytes: inventory.reduce((sum, file) => sum + file.size, 0),
    },
  });
  return { root, manifest };
}
