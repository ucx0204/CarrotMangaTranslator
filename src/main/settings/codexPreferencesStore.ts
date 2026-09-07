import type { AppPaths } from "../appPaths";
import type { GpuInfoProvider } from "../settingsStore";
import { codexTypesettingPreferencesSchema } from "../../shared/codexTypesettingSchemas";
import type { CodexTypesettingPreferences } from "../../shared/codexTypesettingTypes";
import { updateAppSettings } from "../settingsStore";

export async function saveCodexTypesettingPreferences(
  value: CodexTypesettingPreferences,
  paths?: AppPaths,
  env?: NodeJS.ProcessEnv,
  detectGpu?: GpuInfoProvider,
): Promise<CodexTypesettingPreferences> {
  const preferences = codexTypesettingPreferencesSchema.parse(value);
  await updateAppSettings(
    (current) => ({
      ...current,
      ui: { ...current.ui, codexTypesettingPreferences: preferences },
    }),
    paths,
    env,
    detectGpu,
  );
  return preferences;
}
