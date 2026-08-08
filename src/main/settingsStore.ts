import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AppSettings } from "../shared/settingsTypes";
import { getAppPaths, type AppPaths } from "./appPaths";
import {
  normalizeAppSettings,
  parseStoredAppSettings,
  resolveDefaultAppSettings,
} from "./appSettings";
import { CURRENT_GENERATION_LIMITS_VERSION } from "./settings/appSettingsGenerationLimitMigration";
import {
  detectBestGpuInfo,
  resolveAmdRocmTargetFromInfo,
  type DetectedGpuInfo,
} from "./gpuInfo";
import { logError, writeLog } from "./logger";
import { redactDiagnosticText } from "./errorReportRedaction";
import {
  attachSettingsSecrets,
  commitSettingsPair,
  loadCommittedSettingsPair,
  loadSettingsSecrets,
  maskSettingsSecrets,
  resolveSubmittedSettingsSecrets,
  separateSettingsSecrets,
} from "./settingsSecretStore";

export type GpuInfoProvider = () => Promise<DetectedGpuInfo | null>;

export type SettingsStoreDiagnostics = {
  error: (message: string, detail?: unknown) => void;
  warn: (message: string, detail?: unknown) => void;
};

const defaultDiagnostics: SettingsStoreDiagnostics = {
  error: logError,
  warn: (message, detail) => writeLog("warn", message, detail),
};

export async function getAppSettings(
  paths = getAppPaths(),
  env: NodeJS.ProcessEnv = process.env,
  detectGpu: GpuInfoProvider = detectBestGpuInfo,
  diagnostics: SettingsStoreDiagnostics = defaultDiagnostics,
): Promise<AppSettings> {
  const detectedGpu = await detectGpu();
  const defaults = resolveDefaultAppSettings(env, detectedGpu);

  try {
    const committed = await loadCommittedSettingsPair(paths);
    const rawText = committed
      ? committed.rawSettingsText
      : await readFile(paths.settingsPath, "utf8");
    const stored = parseStoredAppSettings(rawText, defaults);
    const plaintext = separateSettingsSecrets(stored);
    const encryptedSecrets = committed
      ? committed.secrets
      : await loadSettingsSecrets(paths);
    const secrets = mergeSettingsSecrets(plaintext.secrets, encryptedSecrets);
    if (!committed || hasSettingsSecrets(plaintext.secrets)) {
      await persistAppSettingsPair(
        plaintext.persistentSettings,
        secrets,
        paths,
      );
    }
    return attachRuntimeHardware(
      attachSettingsSecrets(plaintext.persistentSettings, secrets),
      detectedGpu,
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      const secrets = await loadSettingsSecrets(paths);
      return attachRuntimeHardware(
        attachSettingsSecrets(defaults, secrets),
        detectedGpu,
      );
    }
    if (isJsonParseError(error)) {
      await backupCorruptSettings(paths, error, diagnostics);
      return attachRuntimeHardware(defaults, detectedGpu);
    }
    throw error;
  }
}

export async function saveAppSettings(
  settings: AppSettings,
  paths = getAppPaths(),
  env: NodeJS.ProcessEnv = process.env,
  detectGpu: GpuInfoProvider = detectBestGpuInfo,
): Promise<AppSettings> {
  const detectedGpu = await detectGpu();
  const normalized = normalizeAppSettings(
    settings,
    resolveDefaultAppSettings(env, detectedGpu),
  );
  const existingSecrets = await loadSettingsSecrets(paths);
  const submitted = resolveSubmittedSettingsSecrets(
    stripRuntimeHardware(normalized),
    existingSecrets,
  );
  await persistAppSettingsPair(submitted.settings, submitted.secrets, paths);
  return attachRuntimeHardware(
    attachSettingsSecrets(submitted.settings, submitted.secrets),
    detectedGpu,
  );
}

export async function resetAppSettings(
  paths = getAppPaths(),
  env: NodeJS.ProcessEnv = process.env,
  detectGpu: GpuInfoProvider = detectBestGpuInfo,
): Promise<AppSettings> {
  const detectedGpu = await detectGpu();
  const defaults = resolveDefaultAppSettings(env, detectedGpu);
  await persistAppSettingsPair(
    separateSettingsSecrets(stripRuntimeHardware(defaults)).persistentSettings,
    {},
    paths,
  );
  return attachRuntimeHardware(defaults, detectedGpu);
}

export function maskAppSettingsSecrets(settings: AppSettings): AppSettings {
  return maskSettingsSecrets(settings);
}

export async function hydrateAppSettingsSecretSentinels(
  settings: AppSettings,
  paths = getAppPaths(),
): Promise<AppSettings> {
  const submitted = resolveSubmittedSettingsSecrets(
    settings,
    await loadSettingsSecrets(paths),
  );
  return attachSettingsSecrets(submitted.settings, submitted.secrets);
}

async function persistAppSettingsPair(
  settings: AppSettings,
  secrets: Parameters<typeof commitSettingsPair>[2],
  paths: AppPaths,
): Promise<void> {
  await commitSettingsPair(
    paths,
    {
      generationLimitsVersion: CURRENT_GENERATION_LIMITS_VERSION,
      ...settings,
    },
    secrets,
  );
}

function attachRuntimeHardware(
  settings: AppSettings,
  detectedGpu: DetectedGpuInfo | null,
): AppSettings {
  return {
    ...settings,
    runtimeHardware: {
      gpuVendor: normalizeRuntimeGpuVendor(detectedGpu?.vendor),
      gpuName: detectedGpu?.name ?? null,
      llamaRocmTarget: resolveAmdRocmTargetFromInfo(detectedGpu),
      supportsRocm: detectedGpu?.supportsRocm ?? false,
      supportsVulkan: detectedGpu?.supportsVulkan ?? false,
      supportsMetal: detectedGpu?.supportsMetal ?? false,
      unifiedMemoryMb: detectedGpu?.unifiedMemoryMb ?? null,
    },
  };
}

function normalizeRuntimeGpuVendor(
  vendor: DetectedGpuInfo["vendor"],
): "nvidia" | "amd" | "apple" | "unknown" {
  switch (vendor) {
    case "nvidia":
    case "amd":
    case "apple":
      return vendor;
    default:
      return "unknown";
  }
}

function stripRuntimeHardware(settings: AppSettings): AppSettings {
  const { runtimeHardware: _runtimeHardware, ...persistentSettings } = settings;
  return persistentSettings;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isJsonParseError(error: unknown): boolean {
  return error instanceof SyntaxError;
}

async function backupCorruptSettings(
  paths: AppPaths,
  error: unknown,
  diagnostics: SettingsStoreDiagnostics,
): Promise<void> {
  try {
    const rawText = await readFile(paths.settingsPath, "utf8");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(
      dirname(paths.settingsPath),
      `${basename(paths.settingsPath)}.corrupt-${timestamp}.bak`,
    );
    await mkdir(dirname(backupPath), { recursive: true });
    const redacted = redactDiagnosticText(rawText, { appPaths: paths }).text;
    await writeFile(backupPath, redacted, { encoding: "utf8", mode: 0o600 });
    diagnostics.warn(
      "Settings file is corrupt; backed it up and restored defaults",
      { settingsPath: paths.settingsPath, backupPath },
    );
  } catch (backupError) {
    diagnostics.error("Failed to back up corrupt settings file", {
      settingsPath: paths.settingsPath,
      error,
      backupError,
    });
  }
}

function mergeSettingsSecrets(
  plaintext: ReturnType<typeof separateSettingsSecrets>["secrets"],
  encrypted: Awaited<ReturnType<typeof loadSettingsSecrets>>,
): ReturnType<typeof separateSettingsSecrets>["secrets"] {
  return {
    ...(plaintext.apiKey || encrypted.apiKey
      ? { apiKey: encrypted.apiKey ?? plaintext.apiKey }
      : {}),
    ...((plaintext.credentialHeaders || encrypted.credentialHeaders) && {
      credentialHeaders: {
        ...(plaintext.credentialHeaders ?? {}),
        ...(encrypted.credentialHeaders ?? {}),
      },
    }),
  };
}

function hasSettingsSecrets(
  secrets: ReturnType<typeof separateSettingsSecrets>["secrets"],
): boolean {
  return Boolean(
    secrets.apiKey ||
    (secrets.credentialHeaders &&
      Object.keys(secrets.credentialHeaders).length > 0),
  );
}
