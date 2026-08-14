import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AppPaths } from "./appPaths";
import { renameWithTransientRetry } from "./libraryStore/storage";
import {
  assertSettingsGeneration,
  isSettingsGeneration,
  isSettingsJsonRecord,
  parseSettingsJsonRecord,
  serializeSettingsJson,
} from "./settingsPairCodec";

type SettingsPairReference = {
  generation: string;
  publicSha256: string;
  secretSha256: string;
};

type SettingsCommitPointer = SettingsPairReference & {
  version: 1;
  previous?: SettingsPairReference;
};

export type SettingsPairFiles = {
  generation: string;
  rawSettingsText: string;
  vaultText: string;
};

const SETTINGS_PAIR_DIRECTORY = ".settings-pairs";
const SETTINGS_COMMIT_FILE = "settings.commit.json";
const SETTINGS_PAIR_PUBLIC_FILE = "settings.json";
const SETTINGS_PAIR_SECRET_FILE = "settings.secrets.json";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
let settingsCommitTail: Promise<void> = Promise.resolve();

export async function loadCommittedSettingsPairFiles<T>(
  paths: AppPaths,
  validate: (files: SettingsPairFiles) => T | Promise<T>,
): Promise<T | null> {
  const pointer = await readSettingsCommitPointer(paths);
  if (!pointer) return null;

  try {
    return await loadAndRepairPair(paths, pointer, validate);
  } catch (currentError) {
    if (!pointer.previous) {
      throw new Error("Committed settings pair is incomplete or corrupted.", {
        cause: currentError,
      });
    }
    try {
      const recovered = await loadAndRepairPair(
        paths,
        pointer.previous,
        validate,
      );
      await writeRestrictedJsonFile(settingsCommitPath(paths), {
        version: 1,
        ...pointer.previous,
      });
      return recovered;
    } catch (previousError) {
      throw new AggregateError(
        [currentError, previousError],
        "Current and previous settings pairs are both invalid.",
        { cause: previousError },
      );
    }
  }
}

async function loadAndRepairPair<T>(
  paths: AppPaths,
  reference: SettingsPairReference,
  validate: (files: SettingsPairFiles) => T | Promise<T>,
): Promise<T> {
  const files = await readCommittedPairFiles(paths, reference);
  const validated = await validate(files);
  await repairSettingsMirrors(paths, files);
  return validated;
}

export function commitSettingsPairFiles(
  paths: AppPaths,
  files: SettingsPairFiles,
): Promise<string> {
  const commit = settingsCommitTail.then(() =>
    commitSettingsPairFilesNow(paths, files),
  );
  settingsCommitTail = commit.then(
    () => undefined,
    () => undefined,
  );
  return commit;
}

async function commitSettingsPairFilesNow(
  paths: AppPaths,
  files: SettingsPairFiles,
): Promise<string> {
  assertSettingsGeneration(files.generation);
  const pairDir = settingsPairDirectory(paths, files.generation);
  await mkdir(dirname(pairDir), { recursive: true });
  await mkdir(pairDir, { recursive: false });
  try {
    const reference = await writeAndVerifyPair(paths, files);
    await publishSettingsPair(paths, files, reference);
    return files.generation;
  } catch (error) {
    return recoverCommitResult(paths, pairDir, files.generation, error);
  }
}

async function writeAndVerifyPair(
  paths: AppPaths,
  files: SettingsPairFiles,
): Promise<SettingsPairReference> {
  const pairDir = settingsPairDirectory(paths, files.generation);
  const writes = await Promise.allSettled([
    writeRestrictedTextFile(
      join(pairDir, SETTINGS_PAIR_PUBLIC_FILE),
      files.rawSettingsText,
    ),
    writeRestrictedTextFile(
      join(pairDir, SETTINGS_PAIR_SECRET_FILE),
      files.vaultText,
    ),
  ]);
  const failures = writes.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Could not durably stage both settings pair files.",
      { cause: failures[0] },
    );
  }
  const reference = pairReferenceFor(files);
  await readCommittedPairFiles(paths, reference);
  return reference;
}

async function publishSettingsPair(
  paths: AppPaths,
  files: SettingsPairFiles,
  reference: SettingsPairReference,
): Promise<void> {
  const previous = await readSettingsCommitPointer(paths);
  const pointer: SettingsCommitPointer = {
    version: 1,
    ...reference,
    ...(previous
      ? {
          previous: {
            generation: previous.generation,
            publicSha256: previous.publicSha256,
            secretSha256: previous.secretSha256,
          },
        }
      : {}),
  };
  await writeRestrictedJsonFile(settingsCommitPath(paths), pointer);
  await repairSettingsMirrors(paths, files);
  await cleanupOldSettingsPairs(
    paths,
    new Set(
      [files.generation, previous?.generation].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  );
}

async function recoverCommitResult(
  paths: AppPaths,
  pairDir: string,
  generation: string,
  error: unknown,
): Promise<string> {
  const inspection = await inspectPublishedGeneration(paths);
  if (inspection.pointer?.generation === generation) return generation;
  try {
    await rm(pairDir, { recursive: true, force: true });
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      "Settings pair commit and staging cleanup both failed.",
      { cause: cleanupError },
    );
  }
  if (inspection.error) {
    throw new AggregateError(
      [error, inspection.error],
      "Settings pair commit failed and its publication state could not be verified.",
    );
  }
  throw error;
}

async function inspectPublishedGeneration(
  paths: AppPaths,
): Promise<{ pointer: SettingsCommitPointer | null; error?: unknown }> {
  try {
    return { pointer: await readSettingsCommitPointer(paths) };
  } catch (error) {
    return { pointer: null, error };
  }
}

function pairReferenceFor(files: SettingsPairFiles): SettingsPairReference {
  return {
    generation: files.generation,
    publicSha256: sha256Text(files.rawSettingsText),
    secretSha256: sha256Text(files.vaultText),
  };
}

async function readCommittedPairFiles(
  paths: AppPaths,
  reference: SettingsPairReference,
): Promise<SettingsPairFiles> {
  const pairDir = settingsPairDirectory(paths, reference.generation);
  const [rawSettingsText, vaultText] = await Promise.all([
    readFile(join(pairDir, SETTINGS_PAIR_PUBLIC_FILE), "utf8"),
    readFile(join(pairDir, SETTINGS_PAIR_SECRET_FILE), "utf8"),
  ]);
  if (
    sha256Text(rawSettingsText) !== reference.publicSha256 ||
    sha256Text(vaultText) !== reference.secretSha256
  ) {
    throw new Error("Committed settings pair hash verification failed.");
  }
  return { generation: reference.generation, rawSettingsText, vaultText };
}

async function readSettingsCommitPointer(
  paths: AppPaths,
): Promise<SettingsCommitPointer | null> {
  let rawText: string;
  try {
    rawText = await readFile(settingsCommitPath(paths), "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
  const value = parseSettingsJsonRecord(rawText, "Settings commit pointer");
  if (value.version !== 1) {
    throw new Error("Settings commit pointer version is unsupported.");
  }
  const reference = parseSettingsPairReference(value, "current");
  return {
    version: 1,
    ...reference,
    ...(value.previous === undefined
      ? {}
      : { previous: parseSettingsPairReference(value.previous, "previous") }),
  };
}

function parseSettingsPairReference(
  value: unknown,
  label: string,
): SettingsPairReference {
  if (!isSettingsJsonRecord(value)) {
    throw new Error(`Settings ${label} pair reference is invalid.`);
  }
  const generation = String(value.generation ?? "");
  const publicSha256 = String(value.publicSha256 ?? "").toLowerCase();
  const secretSha256 = String(value.secretSha256 ?? "").toLowerCase();
  assertSettingsGeneration(generation);
  if (
    !SHA256_PATTERN.test(publicSha256) ||
    !SHA256_PATTERN.test(secretSha256)
  ) {
    throw new Error(`Settings ${label} pair hashes are invalid.`);
  }
  return { generation, publicSha256, secretSha256 };
}

async function repairSettingsMirrors(
  paths: AppPaths,
  files: SettingsPairFiles,
): Promise<void> {
  await Promise.all([
    repairSettingsMirror(paths.settingsPath, files.rawSettingsText),
    repairSettingsMirror(settingsSecretMirrorPath(paths), files.vaultText),
  ]);
}

async function repairSettingsMirror(
  filePath: string,
  expectedText: string,
): Promise<void> {
  try {
    try {
      if ((await readFile(filePath, "utf8")) === expectedText) return;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    await writeRestrictedTextFile(filePath, expectedText);
  } catch (_error) {
    // error-policy-allow: mirrors are compatibility projections. The hashed,
    // generation-addressed pair and atomic commit pointer remain authoritative.
  }
}

async function cleanupOldSettingsPairs(
  paths: AppPaths,
  keep: Set<string>,
): Promise<void> {
  const root = join(dirname(paths.settingsPath), SETTINGS_PAIR_DIRECTORY);
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        isSettingsGeneration(entry.name) &&
        !keep.has(entry.name)
      ) {
        await rm(join(root, entry.name), { recursive: true, force: true });
      }
    }
  } catch (_error) {
    // error-policy-allow: stale immutable generations can be removed after the
    // next successful serialized commit.
  }
}

async function writeRestrictedJsonFile(
  filePath: string,
  payload: unknown,
): Promise<void> {
  await writeRestrictedTextFile(filePath, serializeSettingsJson(payload));
}

async function writeRestrictedTextFile(
  filePath: string,
  contents: string,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tmpPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await renameWithTransientRetry(tmpPath, filePath);
    await chmod(filePath, 0o600);
    await syncDirectory(dirname(filePath));
  } catch (error) {
    try {
      await handle?.close();
    } catch (_closeError) {
      // error-policy-allow: preserve the primary durable-write failure; the OS
      // releases the temporary handle when the process exits.
    }
    try {
      await rm(tmpPath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Restricted file write and temporary-file cleanup both failed.",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (_error) {
    // error-policy-allow: directory fsync is unavailable on some Windows
    // filesystems. File fsync plus atomic rename still protects file contents.
  } finally {
    try {
      await handle?.close();
    } catch (_error) {
      // error-policy-allow: best-effort directory durability is already
      // unsupported on this filesystem; a close failure cannot undo the
      // fsynced file and atomic rename.
    }
  }
}

export function settingsCommitPath(paths: AppPaths): string {
  return join(dirname(paths.settingsPath), SETTINGS_COMMIT_FILE);
}

export function settingsPairDirectory(
  paths: AppPaths,
  generation: string,
): string {
  assertSettingsGeneration(generation);
  return join(dirname(paths.settingsPath), SETTINGS_PAIR_DIRECTORY, generation);
}

function settingsSecretMirrorPath(paths: AppPaths): string {
  return join(dirname(paths.settingsPath), SETTINGS_PAIR_SECRET_FILE);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
