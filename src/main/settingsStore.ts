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
import { writeJsonFile } from "./libraryStore/storage";
import { logError, writeLog } from "./logger";

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
    const rawText = await readFile(paths.settingsPath, "utf8");
    return attachRuntimeHardware(
      parseStoredAppSettings(rawText, defaults),
      detectedGpu,
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      return attachRuntimeHardware(defaults, detectedGpu);
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
  await persistAppSettings(stripRuntimeHardware(normalized), paths);
  return attachRuntimeHardware(normalized, detectedGpu);
}

export async function resetAppSettings(
  paths = getAppPaths(),
  env: NodeJS.ProcessEnv = process.env,
  detectGpu: GpuInfoProvider = detectBestGpuInfo,
): Promise<AppSettings> {
  const detectedGpu = await detectGpu();
  const defaults = resolveDefaultAppSettings(env, detectedGpu);
  await persistAppSettings(stripRuntimeHardware(defaults), paths);
  return attachRuntimeHardware(defaults, detectedGpu);
}

async function persistAppSettings(
  settings: AppSettings,
  paths: AppPaths,
): Promise<void> {
  await writeJsonFile(paths.settingsPath, {
    generationLimitsVersion: CURRENT_GENERATION_LIMITS_VERSION,
    ...settings,
  });
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
    await writeFile(backupPath, rawText, "utf8");
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
