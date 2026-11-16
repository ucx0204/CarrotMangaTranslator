import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { AppPaths } from "./appPaths";
import {
  serializeSettingsJson,
  type SettingsPairFiles,
} from "./settingsPairCodec";

export type SettingsPairReference = {
  generation: string;
  publicSha256: string;
  secretSha256: string;
};

export type SettingsCommitPointer = SettingsPairReference & {
  version: 1;
  previous?: SettingsPairReference;
};

type RecoveryStorage = {
  readPointer: (paths: AppPaths) => Promise<SettingsCommitPointer | null>;
  readPair: (
    paths: AppPaths,
    reference: SettingsPairReference,
  ) => Promise<SettingsPairFiles>;
  writeText: (path: string, text: string) => Promise<void>;
  commit: (paths: AppPaths, files: SettingsPairFiles) => Promise<string>;
};

export function createSettingsPairRecovery(
  storage: RecoveryStorage & {
    run: <T>(operation: () => Promise<T>) => Promise<T>;
  },
): (
  paths: AppPaths,
  replace: (current: SettingsPairFiles) => SettingsPairFiles,
) => Promise<void> {
  return (paths, replace) =>
    storage.run(() => recoverSettingsPairWithBackup(paths, replace, storage));
}

/** The caller holds the existing settings-pair queue throughout backup and commit. */
async function recoverSettingsPairWithBackup(
  paths: AppPaths,
  replace: (current: SettingsPairFiles) => SettingsPairFiles,
  storage: RecoveryStorage,
): Promise<void> {
  const pointer = await storage.readPointer(paths);
  if (!pointer)
    throw new Error("No committed settings pair is available for recovery.");
  const current = await storage.readPair(paths, pointer);
  const replacement = replace(current);
  const pairs = [current];
  if (pointer.previous)
    pairs.push(await storage.readPair(paths, pointer.previous));
  const backupRoot = join(
    dirname(paths.settingsPath),
    ".settings-credential-backups",
    randomUUID(),
  );
  for (const pair of pairs) {
    const destination = join(backupRoot, ".settings-pairs", pair.generation);
    await storage.writeText(
      join(destination, "settings.json"),
      pair.rawSettingsText,
    );
    await storage.writeText(
      join(destination, "settings.secrets.json"),
      pair.vaultText,
    );
  }
  await storage.writeText(
    join(backupRoot, "settings.commit.json"),
    serializeSettingsJson(pointer),
  );
  await storage.commit(paths, replacement);
}
