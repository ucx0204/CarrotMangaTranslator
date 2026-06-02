import { app } from "electron";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type AppPaths = {
  isPackaged: boolean;
  repoRoot: string;
  executableDir: string;
  resourcesDir: string;
  dataRoot: string;
  settingsPath: string;
  libraryDir: string;
  fontsDir: string;
  logsDir: string;
  logFile: string;
  runtimeDir: string;
  toolsDir: string;
  ocrRuntimeDir: string;
  llamaRuntimeDir: string;
  llamaServerPath: string;
  hfHomeDir?: string;
  hfHubCacheDir?: string;
};

function isRunningPackaged(): boolean {
  return app.isPackaged || __dirname.includes("app.asar");
}

export function getAppPaths(): AppPaths {
  const isPackaged = isRunningPackaged();
  const repoRoot = resolve(__dirname, "../..");
  const executableDir = dirname(process.execPath);
  const resourcesDir = process.resourcesPath;
  const dataRoot = isPackaged ? resolvePackagedDataRoot(executableDir) : repoRoot;
  const libraryDir = isPackaged ? join(dataRoot, "library") : join(repoRoot, "library");
  const logsDir = isPackaged ? join(dataRoot, "logs") : join(repoRoot, "logs");
  const runtimeDir = isPackaged ? join(resourcesDir, "app-runtime") : join(repoRoot, "out", "app-runtime");
  const toolsDir = isPackaged ? join(resourcesDir, "tools") : join(repoRoot, "tools");
  const explicitOcrRuntimeDir = process.env.MANGA_TRANSLATOR_OCR_RUNTIME_DIR?.trim();
  const ocrRuntimeDir = explicitOcrRuntimeDir || (
    process.platform === "win32"
      ? join(process.env.LOCALAPPDATA || dataRoot, "manga-gemma-translator", "ocr-runtime")
      : join(dataRoot, "ocr-runtime")
  );
  const llamaRuntimeDir = join(toolsDir, "beellama-v0.2.0-cuda12.4");
  const llamaServerBinary = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  const explicitHfHome = process.env.MANGA_TRANSLATOR_HF_HOME?.trim();
  const explicitHubCache = process.env.HF_HUB_CACHE?.trim() || process.env.HUGGINGFACE_HUB_CACHE?.trim();
  const hfHomeDir = isPackaged ? join(dataRoot, "hf-cache") : explicitHfHome || undefined;
  const hfHubCacheDir = isPackaged ? join(dataRoot, "hf-cache", "hub") : explicitHubCache || undefined;

  return {
    isPackaged,
    repoRoot,
    executableDir,
    resourcesDir,
    dataRoot,
    settingsPath: join(dataRoot, "settings.json"),
    libraryDir,
    fontsDir: join(dataRoot, "fonts"),
    logsDir,
    logFile: join(logsDir, "app.log"),
    runtimeDir,
    toolsDir,
    ocrRuntimeDir,
    llamaRuntimeDir,
    llamaServerPath: join(llamaRuntimeDir, llamaServerBinary),
    hfHomeDir,
    hfHubCacheDir
  };
}

export function ensureWritableAppDirectories(): AppPaths {
  const paths = getAppPaths();
  migrateLegacyPackagedData(paths);
  mkdirSync(paths.libraryDir, { recursive: true });
  mkdirSync(paths.fontsDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  if (paths.hfHomeDir) {
    mkdirSync(paths.hfHomeDir, { recursive: true });
  }
  if (paths.hfHubCacheDir) {
    mkdirSync(paths.hfHubCacheDir, { recursive: true });
  }
  mkdirSync(paths.ocrRuntimeDir, { recursive: true });
  return paths;
}

function resolvePackagedDataRoot(executableDir: string): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) {
      return join(localAppData, "manga-gemma-translator");
    }
  }

  try {
    return app.getPath("userData");
  } catch {
    return join(executableDir, "data");
  }
}

function migrateLegacyPackagedData(paths: AppPaths): void {
  if (!paths.isPackaged) {
    return;
  }

  const legacyDataRoot = join(paths.executableDir, "data");
  if (resolve(legacyDataRoot) === resolve(paths.dataRoot) || !existsSync(legacyDataRoot)) {
    return;
  }

  copyDirectoryContentsIfMissing(legacyDataRoot, paths.dataRoot);
}

function copyDirectoryContentsIfMissing(sourceDir: string, targetDir: string): void {
  if (!existsSync(sourceDir)) {
    return;
  }

  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryContentsIfMissing(sourcePath, targetPath);
      continue;
    }

    if (!entry.isFile() || existsSync(targetPath)) {
      continue;
    }

    const parentDir = dirname(targetPath);
    mkdirSync(parentDir, { recursive: true });
    if (statSync(sourcePath).isFile()) {
      copyFileSync(sourcePath, targetPath);
    }
  }
}
