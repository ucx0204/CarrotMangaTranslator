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
import { supportsWindowsRocmOcrGpu } from "./settings/ocrRocmSupport";
import { resolveWindowsHipSdkGpuSupport } from "./settings/fluxZludaSupport";
import { hasExplicitOcrGpuEnableOverride } from "./settings/ocrRuntimeOverrides";
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
    const stored = parseStoredAppSettings(
      rawText,
      defaults,
      resolveOcrNormalizationPolicy(env, detectedGpu),
    );
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
  const normalized = await normalizeAppSettingsForRuntime(
    settings,
    env,
    detectGpu,
  );
  const existingSecrets = await loadSettingsSecrets(paths);
  const submitted = resolveSubmittedSettingsSecrets(
    stripRuntimeHardware(normalized),
    existingSecrets,
  );
  await persistAppSettingsPair(submitted.settings, submitted.secrets, paths);
  return attachSettingsSecrets(
    {
      ...submitted.settings,
      runtimeHardware: normalized.runtimeHardware,
    },
    submitted.secrets,
  );
}

/** Apply the exact hardware-aware normalization used by Save without writing. */
export async function normalizeAppSettingsForRuntime(
  settings: AppSettings,
  env: NodeJS.ProcessEnv = process.env,
  detectGpu: GpuInfoProvider = detectBestGpuInfo,
): Promise<AppSettings> {
  const detectedGpu = await detectGpu();
  return attachRuntimeHardware(
    normalizeAppSettings(
      settings,
      resolveDefaultAppSettings(env, detectedGpu),
      resolveOcrNormalizationPolicy(env, detectedGpu),
    ),
    detectedGpu,
  );
}

function resolveOcrNormalizationPolicy(
  env: NodeJS.ProcessEnv,
  detectedGpu: DetectedGpuInfo | null,
) {
  return {
    allowUnsupportedAmdOcrGpu: hasExplicitOcrGpuEnableOverride(env),
    detectedHardwareVendor: detectedGpu
      ? normalizeRuntimeGpuVendor(detectedGpu.vendor)
      : "unknown",
    ...(detectedGpu?.vendor === "amd"
      ? { detectedAmdOcrRocmSupport: supportsWindowsRocmOcrGpu(detectedGpu) }
      : {}),
  };
}

/**
 * Resolve hardware-aware defaults without writing them. The settings dialog
 * uses this as a draft source; persistence still happens only through Save.
 */
export async function getDefaultAppSettings(
  env: NodeJS.ProcessEnv = process.env,
  detectGpu: GpuInfoProvider = detectBestGpuInfo,
): Promise<AppSettings> {
  const detectedGpu = await detectGpu();
  return attachRuntimeHardware(
    resolveDefaultAppSettings(env, detectedGpu),
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
    runtimeHardware: detectedGpu
      ? createDetectedRuntimeHardware(detectedGpu)
      : createUnknownRuntimeHardware(),
  };
}

function createDetectedRuntimeHardware(
  detectedGpu: DetectedGpuInfo,
): NonNullable<AppSettings["runtimeHardware"]> {
  return {
    gpuVendor: normalizeRuntimeGpuVendor(detectedGpu.vendor),
    gpuName: detectedGpu.name,
    gpuMemoryMb: detectedGpu.memoryMb,
    computeCapability: resolveRuntimeComputeCapability(detectedGpu),
    rtxGeneration: resolveRuntimeRtxGeneration(detectedGpu),
    llamaRocmTarget: resolveAmdRocmTargetFromInfo(detectedGpu),
    ...(detectedGpu.vendor === "amd"
      ? {
          supportsOcrRocm: supportsWindowsRocmOcrGpu(detectedGpu),
          supportsFluxZluda:
            resolveWindowsHipSdkGpuSupport(detectedGpu),
        }
      : {}),
    supportsRocm: Boolean(detectedGpu.supportsRocm),
    supportsVulkan: Boolean(detectedGpu.supportsVulkan),
    supportsMetal: Boolean(detectedGpu.supportsMetal),
    unifiedMemoryMb: detectedGpu.unifiedMemoryMb,
  };
}

function createUnknownRuntimeHardware(): NonNullable<
  AppSettings["runtimeHardware"]
> {
  return {
    gpuVendor: "unknown",
    gpuName: null,
    gpuMemoryMb: null,
    computeCapability: null,
    rtxGeneration: null,
    llamaRocmTarget: null,
    supportsRocm: false,
    supportsVulkan: false,
    supportsMetal: false,
    unifiedMemoryMb: null,
  };
}

function resolveRuntimeComputeCapability(
  detectedGpu: DetectedGpuInfo | null,
): number | null {
  return detectedGpu?.computeCapability ?? null;
}

function resolveRuntimeRtxGeneration(
  detectedGpu: DetectedGpuInfo | null,
): number | null {
  return detectedGpu?.rtxGeneration ?? null;
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
