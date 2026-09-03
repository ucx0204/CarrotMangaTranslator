import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppSettings } from "../shared/settingsTypes";
import { API_PROVIDER_PRESET_IDS } from "../shared/apiProviderPresets";
import { SETTINGS_SECRET_PRESERVE_SENTINEL } from "../shared/settingsSecrets";
import type { AppPaths } from "./appPaths";
import {
  commitSettingsPairFiles,
  loadCommittedSettingsPairFiles,
  type SettingsPairFiles,
} from "./settingsPairStorage";
import {
  parseSettingsJsonRecord,
  serializeSettingsJson,
} from "./settingsPairCodec";
import {
  attachApiProfileSecrets,
  cleanSecret,
  hasApiProfileSecrets,
  maskApiProfileSecrets,
  normalizeSecrets,
  parseHeaderRecord,
  readActiveApiProfile,
  readApiProfile,
  resolveActiveApiProvider,
  resolveApiProfileSecrets,
  resolveSubmittedApiProfileSecrets,
  separateApiProfileSecrets,
  type SettingsSecrets,
} from "./settingsSecretProfiles";
import {
  createEncryptedSecretVault,
  decryptVault,
  parseEncryptedVault,
  type EncryptedSecretVault,
  type LegacyEncryptedSecretVault,
} from "./settingsSecretVaultCodec";

export type CommittedSettingsPair = {
  generation: string;
  rawSettingsText: string;
  secrets: SettingsSecrets;
};

export async function loadSettingsSecrets(
  paths: AppPaths,
): Promise<SettingsSecrets> {
  const committed = await loadCommittedSettingsPair(paths);
  if (committed) return committed.secrets;

  let publicSettings: Record<string, unknown>;
  try {
    publicSettings = parseSettingsJsonRecord(
      await readFile(paths.settingsPath, "utf8"),
      "Public settings file",
    );
  } catch (error) {
    if (isMissingFileError(error)) return {};
    throw error;
  }

  let vault: LegacyEncryptedSecretVault | EncryptedSecretVault;
  try {
    vault = parseEncryptedVault(
      await readFile(settingsSecretVaultPath(paths), "utf8"),
    );
  } catch (error) {
    if (isMissingFileError(error)) return {};
    throw new Error("Encrypted settings secret vault is unreadable.", {
      cause: error,
    });
  }

  if (vault.version === 1) {
    // A v1 vault predates endpoint/credential generation binding. There is no
    // cryptographic or transactional evidence that it belongs to this public
    // settings file, so fail closed and require the user to enter credentials
    // again instead of risking delivery to an older endpoint.
    return {};
  }
  if (publicSettings.secretGeneration !== vault.generation) {
    throw new Error(
      "Public settings and encrypted secrets belong to different generations.",
    );
  }
  return decryptVault(vault);
}

export async function loadCommittedSettingsPair(
  paths: AppPaths,
): Promise<CommittedSettingsPair | null> {
  return loadCommittedSettingsPairFiles(paths, decodeCommittedSettingsPair);
}

export function commitSettingsPair(
  paths: AppPaths,
  publicSettings: Record<string, unknown>,
  secrets: SettingsSecrets,
): Promise<string> {
  const generation = randomUUID();
  const publicPayload = {
    ...publicSettings,
    secretGeneration: generation,
  };
  const vault = createEncryptedSecretVault(generation, secrets);
  const publicText = serializeSettingsJson(publicPayload);
  const vaultText = serializeSettingsJson(vault);
  // Validate the codec and OS decryption path before publishing the pair.
  decodeCommittedSettingsPair({
    generation,
    rawSettingsText: publicText,
    vaultText,
  });
  return commitSettingsPairFiles(paths, {
    generation,
    rawSettingsText: publicText,
    vaultText,
  });
}

export function separateSettingsSecrets(settings: AppSettings): {
  persistentSettings: AppSettings;
  secrets: SettingsSecrets;
} {
  const provider = resolveActiveApiProvider(settings);
  const apiProfiles: NonNullable<SettingsSecrets["apiProfiles"]> = {};
  const publicProfiles: NonNullable<AppSettings["api"]["profiles"]> = {};
  const storedProfiles = settings.api.profiles ?? {};
  for (const candidate of API_PROVIDER_PRESET_IDS) {
    const stored = storedProfiles[candidate];
    if (!stored && candidate !== provider) continue;
    const profile =
      candidate === provider
        ? { ...(stored ?? {}), ...readActiveApiProfile(settings) }
        : (stored as NonNullable<typeof stored>);
    const separated = separateApiProfileSecrets(profile);
    publicProfiles[candidate] = separated.profile;
    if (hasApiProfileSecrets(separated.secrets)) {
      apiProfiles[candidate] = separated.secrets;
    }
  }
  const activeProfile =
    publicProfiles[provider] ?? separateApiProfileSecrets(settings.api).profile;
  publicProfiles[provider] = activeProfile;
  const internetResearch = { ...settings.internetResearch };
  const tavilyApiKey = cleanSecret(internetResearch.tavilyApiKey);
  delete internetResearch.tavilyApiKey;
  return {
    persistentSettings: {
      ...settings,
      api: { ...activeProfile, provider, profiles: publicProfiles },
      internetResearch,
    },
    secrets: normalizeSecrets({ apiProfiles, tavilyApiKey }),
  };
}

export function attachSettingsSecrets(
  settings: AppSettings,
  secrets: SettingsSecrets,
): AppSettings {
  const provider = resolveActiveApiProvider(settings);
  const publicProfiles = settings.api.profiles ?? {};
  const profiles: NonNullable<AppSettings["api"]["profiles"]> = {};
  for (const candidate of API_PROVIDER_PRESET_IDS) {
    const publicProfile = publicProfiles[candidate];
    if (!publicProfile && candidate !== provider) continue;
    const profile =
      candidate === provider
        ? { ...(publicProfile ?? {}), ...readActiveApiProfile(settings) }
        : (publicProfile as NonNullable<typeof publicProfile>);
    profiles[candidate] = attachApiProfileSecrets(
      profile,
      resolveApiProfileSecrets(secrets, candidate, provider),
    );
  }
  const activeProfile =
    profiles[provider] ??
    attachApiProfileSecrets(
      settings.api,
      resolveApiProfileSecrets(secrets, provider, provider),
    );
  profiles[provider] = activeProfile;
  return {
    ...settings,
    internetResearch: {
      ...settings.internetResearch,
      ...(secrets.tavilyApiKey ? { tavilyApiKey: secrets.tavilyApiKey } : {}),
    },
    api: {
      ...activeProfile,
      provider,
      profiles,
    },
  };
}

export function resolveSubmittedSettingsSecrets(
  settings: AppSettings,
  existing: SettingsSecrets,
): { settings: AppSettings; secrets: SettingsSecrets } {
  const submitted = separateSettingsSecrets(settings);
  const provider = resolveActiveApiProvider(settings);
  const apiProfiles: NonNullable<SettingsSecrets["apiProfiles"]> = {};
  for (const candidate of API_PROVIDER_PRESET_IDS) {
    const submittedProfile = readApiProfile(settings, candidate, provider);
    const submittedSecrets = submitted.secrets.apiProfiles?.[candidate] ?? {};
    const existingSecrets = resolveApiProfileSecrets(
      existing,
      candidate,
      provider,
    );
    const resolved = resolveSubmittedApiProfileSecrets(
      submittedProfile,
      submittedSecrets,
      existingSecrets,
    );
    if (hasApiProfileSecrets(resolved)) apiProfiles[candidate] = resolved;
  }
  const tavilyApiKey =
    settings.internetResearch.tavilyApiKey === SETTINGS_SECRET_PRESERVE_SENTINEL
      ? existing.tavilyApiKey
      : submitted.secrets.tavilyApiKey;
  return {
    settings: submitted.persistentSettings,
    secrets: normalizeSecrets({
      apiProfiles,
      tavilyApiKey,
    }),
  };
}

export function hasSettingsSecretSentinels(settings: AppSettings): boolean {
  if (settings.api.apiKey === SETTINGS_SECRET_PRESERVE_SENTINEL) return true;
  if (
    settings.internetResearch.tavilyApiKey === SETTINGS_SECRET_PRESERVE_SENTINEL
  ) {
    return true;
  }
  const profiles = settings.api.profiles ?? {};
  return [settings.api, ...Object.values(profiles)].some(
    (profile) =>
      profile?.apiKey === SETTINGS_SECRET_PRESERVE_SENTINEL ||
      Object.values(parseHeaderRecord(profile?.customHeadersJson)).some(
        (value) => value === SETTINGS_SECRET_PRESERVE_SENTINEL,
      ),
  );
}

export function maskSettingsSecrets(settings: AppSettings): AppSettings {
  const provider = resolveActiveApiProvider(settings);
  const profiles: NonNullable<AppSettings["api"]["profiles"]> = {};
  for (const candidate of API_PROVIDER_PRESET_IDS) {
    const profile = readApiProfile(settings, candidate, provider);
    if (profile) profiles[candidate] = maskApiProfileSecrets(profile);
  }
  const activeProfile =
    profiles[provider] ?? maskApiProfileSecrets(settings.api);
  profiles[provider] = activeProfile;
  return {
    ...settings,
    internetResearch: {
      ...settings.internetResearch,
      ...(settings.internetResearch.tavilyApiKey
        ? { tavilyApiKey: SETTINGS_SECRET_PRESERVE_SENTINEL }
        : {}),
    },
    api: {
      ...activeProfile,
      provider,
      profiles,
    },
  };
}

export function settingsSecretVaultPath(paths: AppPaths): string {
  return join(dirname(paths.settingsPath), "settings.secrets.json");
}

function decodeCommittedSettingsPair(
  files: SettingsPairFiles,
): CommittedSettingsPair {
  const publicSettings = parseSettingsJsonRecord(
    files.rawSettingsText,
    "Committed public settings",
  );
  const vault = parseEncryptedVault(files.vaultText);
  if (
    vault.version !== 2 ||
    publicSettings.secretGeneration !== files.generation ||
    vault.generation !== files.generation
  ) {
    throw new Error("Committed settings pair generation verification failed.");
  }
  return {
    generation: files.generation,
    rawSettingsText: files.rawSettingsText,
    secrets: decryptVault(vault),
  };
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
