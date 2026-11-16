import type { AppSettings } from "../shared/settingsTypes";
import type { AppPaths } from "./appPaths";
import { parseStoredAppSettings } from "./appSettings";
import { withSettingsMutation } from "./settings/settingsMutationQueue";
import { withExecutionSettings } from "./settings/executionSettings";
import { CURRENT_GENERATION_LIMITS_VERSION } from "./settings/appSettingsGenerationLimitMigration";
import {
  getAppSettings,
  getDefaultAppSettings,
  type GpuInfoProvider,
} from "./settingsStore";
import { recoverSettingsPairFiles } from "./settingsPairStorage";
import {
  createSettingsPairFiles,
  separateSettingsSecrets,
} from "./settingsSecretStore";
import { decryptVault, parseEncryptedVault } from "./settingsSecretVaultCodec";
import { parseSettingsJsonRecord } from "./settingsPairCodec";
import { isSettingsSecretDecryptionError } from "./settingsSecretErrors";

/** Only an explicitly confirmed recovery may replace unreadable credentials. */
export function recoverSettingsCredentials(
  paths: AppPaths,
  env: NodeJS.ProcessEnv = process.env,
  detectGpu?: GpuInfoProvider,
): Promise<AppSettings> {
  return withSettingsMutation(paths.settingsPath, () =>
    withExecutionSettings(undefined, async () => {
      try {
        return await getAppSettings(paths, env, detectGpu);
      } catch (error) {
        if (!isSettingsSecretDecryptionError(error)) throw error;
      }
      const defaults = await getDefaultAppSettings(env, detectGpu);
      await recoverSettingsPairFiles(paths, (current) => {
        const record = parseSettingsJsonRecord(
          current.rawSettingsText,
          "Saved public settings",
        );
        const vault = parseEncryptedVault(current.vaultText);
        if (
          record.secretGeneration !== current.generation ||
          vault.version !== 2 ||
          vault.generation !== current.generation
        ) {
          throw new Error(
            "Settings generation changed; reload settings before recovery.",
          );
        }
        try {
          decryptVault(vault);
        } catch (error) {
          if (!isSettingsSecretDecryptionError(error)) throw error;
          const stored = parseStoredAppSettings(
            current.rawSettingsText,
            defaults,
          );
          const { persistentSettings } = separateSettingsSecrets(stored);
          return createSettingsPairFiles(
            {
              ...persistentSettings,
              generationLimitsVersion: CURRENT_GENERATION_LIMITS_VERSION,
            },
            {},
          );
        }
        throw new Error(
          "Settings credentials are readable again; reload settings.",
        );
      });
      return getAppSettings(paths, env, detectGpu);
    }),
  );
}
