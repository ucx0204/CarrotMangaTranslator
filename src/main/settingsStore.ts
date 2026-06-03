import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AppSettings } from "../shared/types";
import { getAppPaths, type AppPaths } from "./appPaths";
import { normalizeAppSettings, parseStoredAppSettings, resolveDefaultAppSettings } from "./appSettings";
import { detectBestGpuInfo } from "./gpuInfo";
import { writeJsonFile } from "./libraryStore/storage";
import { logError, writeLog } from "./logger";

export async function getAppSettings(paths = getAppPaths(), env: NodeJS.ProcessEnv = process.env): Promise<AppSettings> {
  const defaults = resolveDefaultAppSettings(env, await detectBestGpuInfo());

  try {
    const rawText = await readFile(paths.settingsPath, "utf8");
    return parseStoredAppSettings(rawText, defaults);
  } catch (error) {
    if (isMissingFileError(error)) {
      return defaults;
    }
    if (isJsonParseError(error)) {
      await backupCorruptSettings(paths, error);
      return defaults;
    }
    throw error;
  }
}

export async function saveAppSettings(
  settings: AppSettings,
  paths = getAppPaths(),
  env: NodeJS.ProcessEnv = process.env
): Promise<AppSettings> {
  const normalized = normalizeAppSettings(settings, resolveDefaultAppSettings(env, await detectBestGpuInfo()));
  await persistAppSettings(normalized, paths);
  return normalized;
}

export async function resetAppSettings(paths = getAppPaths(), env: NodeJS.ProcessEnv = process.env): Promise<AppSettings> {
  const defaults = resolveDefaultAppSettings(env, await detectBestGpuInfo());
  await persistAppSettings(defaults, paths);
  return defaults;
}

async function persistAppSettings(settings: AppSettings, paths: AppPaths): Promise<void> {
  await writeJsonFile(paths.settingsPath, settings);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isJsonParseError(error: unknown): boolean {
  return error instanceof SyntaxError;
}

async function backupCorruptSettings(paths: AppPaths, error: unknown): Promise<void> {
  try {
    const rawText = await readFile(paths.settingsPath, "utf8");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(dirname(paths.settingsPath), `${basename(paths.settingsPath)}.corrupt-${timestamp}.bak`);
    await mkdir(dirname(backupPath), { recursive: true });
    await writeFile(backupPath, rawText, "utf8");
    writeLog("warn", "Settings file is corrupt; backed it up and restored defaults", { settingsPath: paths.settingsPath, backupPath });
  } catch (backupError) {
    logError("Failed to back up corrupt settings file", { settingsPath: paths.settingsPath, error, backupError });
  }
}
