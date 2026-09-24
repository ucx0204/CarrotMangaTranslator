import { readFile } from "node:fs/promises";
import type { AppPaths } from "./appPaths";
import { loadCommittedSettingsPairFiles } from "./settingsPairStorage";
import { parseSettingsJsonRecord } from "./settingsPairCodec";

/** Project non-secret metadata from the canonical generation without migration,
 * mirror repair, rollback, hardware probing or secret decryption. */
export async function inspectStoredPublicSettings<T>(
  paths: AppPaths,
  project: (record: Record<string, unknown>) => T,
): Promise<T> {
  const committed = await loadCommittedSettingsPairFiles(
    paths,
    (files) => {
      const record = parseSettingsJsonRecord(
        files.rawSettingsText,
        "Saved public settings",
      );
      if (record.secretGeneration !== files.generation)
        throw new Error(
          "Saved settings generation is inconsistent; open app settings to repair it.",
        );
      return { value: project(record) };
    },
    { readOnly: true },
  );
  if (committed) return committed.value;
  let text: string;
  try {
    text = await readFile(paths.settingsPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return project({});
    throw error;
  }
  return project(parseSettingsJsonRecord(text, "Saved public settings"));
}
