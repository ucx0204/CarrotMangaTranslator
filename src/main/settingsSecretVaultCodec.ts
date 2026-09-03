import { safeStorage } from "electron";
import { API_PROVIDER_PRESET_IDS } from "../shared/apiProviderPresets";
import {
  assertSettingsGeneration,
  isSettingsJsonRecord,
  parseSettingsJsonRecord,
} from "./settingsPairCodec";
import {
  cleanSecret,
  hasApiProfileSecrets,
  normalizeApiProfileSecrets,
  normalizeSecrets,
  type SettingsSecrets,
} from "./settingsSecretProfiles";

export type LegacyEncryptedSecretVault = {
  version: 1;
  apiKey?: string;
  tavilyApiKey?: string;
  credentialHeaders?: string;
};

export type EncryptedSecretVault = {
  version: 2;
  generation: string;
  apiKey?: string;
  tavilyApiKey?: string;
  credentialHeaders?: string;
  apiProfiles?: string;
};

export function createEncryptedSecretVault(
  generation: string,
  secrets: SettingsSecrets,
): EncryptedSecretVault {
  const normalized = normalizeSecrets(secrets);
  return {
    version: 2,
    generation,
    ...(normalized.apiKey ? { apiKey: encryptSecret(normalized.apiKey) } : {}),
    ...(normalized.tavilyApiKey
      ? { tavilyApiKey: encryptSecret(normalized.tavilyApiKey) }
      : {}),
    ...(normalized.credentialHeaders
      ? {
          credentialHeaders: encryptSecret(
            JSON.stringify(normalized.credentialHeaders),
          ),
        }
      : {}),
    ...(normalized.apiProfiles
      ? { apiProfiles: encryptSecret(JSON.stringify(normalized.apiProfiles)) }
      : {}),
  };
}

export function parseEncryptedVault(
  rawText: string,
): LegacyEncryptedSecretVault | EncryptedSecretVault {
  const value = parseSettingsJsonRecord(
    rawText,
    "Encrypted settings secret vault",
  );
  if (value.version !== 1 && value.version !== 2) {
    throw new Error("Encrypted settings secret vault version is unsupported.");
  }
  const fields = parseEncryptedVaultFields(value);
  if (value.version === 1) return { version: 1, ...fields };
  const generation = String(value.generation ?? "");
  assertSettingsGeneration(generation);
  return { version: 2, generation, ...fields };
}

function parseEncryptedVaultFields(value: Record<string, unknown>): {
  apiKey?: string;
  tavilyApiKey?: string;
  credentialHeaders?: string;
  apiProfiles?: string;
} {
  const apiKey = parseOptionalEncryptedField(value.apiKey);
  const tavilyApiKey = parseOptionalEncryptedField(value.tavilyApiKey);
  const credentialHeaders = parseOptionalEncryptedField(
    value.credentialHeaders,
  );
  const apiProfiles = parseOptionalEncryptedField(value.apiProfiles);
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(tavilyApiKey ? { tavilyApiKey } : {}),
    ...(credentialHeaders ? { credentialHeaders } : {}),
    ...(apiProfiles ? { apiProfiles } : {}),
  };
}

function parseOptionalEncryptedField(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error("Encrypted settings secret vault fields are invalid.");
  }
  return value || undefined;
}

export function decryptVault(
  vault: LegacyEncryptedSecretVault | EncryptedSecretVault,
): SettingsSecrets {
  const secrets: SettingsSecrets = {};
  if (vault.apiKey) secrets.apiKey = decryptSecret(vault.apiKey);
  if (vault.tavilyApiKey) {
    secrets.tavilyApiKey = decryptSecret(vault.tavilyApiKey);
  }
  if (vault.credentialHeaders) {
    secrets.credentialHeaders = decryptRecord(
      vault.credentialHeaders,
      "Encrypted credential headers are invalid.",
    );
  }
  if ("apiProfiles" in vault && vault.apiProfiles) {
    const profiles = parseDecryptedApiProfiles(
      decryptRecord(
        vault.apiProfiles,
        "Encrypted API provider credentials are invalid.",
      ),
    );
    if (Object.keys(profiles).length > 0) secrets.apiProfiles = profiles;
  }
  return normalizeSecrets(secrets);
}

function decryptRecord(
  encrypted: string,
  invalidMessage: string,
): Record<string, unknown> {
  const parsed = JSON.parse(decryptSecret(encrypted)) as unknown;
  if (!isSettingsJsonRecord(parsed)) throw new Error(invalidMessage);
  return parsed;
}

function parseDecryptedApiProfiles(
  value: Record<string, unknown>,
): NonNullable<SettingsSecrets["apiProfiles"]> {
  const profiles: NonNullable<SettingsSecrets["apiProfiles"]> = {};
  for (const provider of API_PROVIDER_PRESET_IDS) {
    const raw = value[provider];
    if (!isSettingsJsonRecord(raw)) continue;
    const normalized = normalizeApiProfileSecrets({
      apiKey: cleanSecret(raw.apiKey),
      credentialHeaders: isSettingsJsonRecord(raw.credentialHeaders)
        ? raw.credentialHeaders
        : undefined,
    });
    if (hasApiProfileSecrets(normalized)) profiles[provider] = normalized;
  }
  return profiles;
}

function encryptSecret(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS-backed settings encryption is unavailable.");
  }
  return safeStorage.encryptString(value).toString("base64");
}

function decryptSecret(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS-backed settings encryption is unavailable.");
  }
  return safeStorage.decryptString(Buffer.from(value, "base64"));
}
