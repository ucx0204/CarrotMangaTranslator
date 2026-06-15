import { app } from "electron";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  DATA_ROOT_MARKER_FILE,
  legacyAppDataRoots,
  resolvePackagedDataRoot,
} from "./dataRoot";

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
  llamaCacheDir?: string;
};

function isRunningPackaged(): boolean {
  return app.isPackaged || __dirname.includes("app.asar");
}

export function getAppPaths(): AppPaths {
  const isPackaged = isRunningPackaged();
  const repoRoot = resolve(__dirname, "../..");
  const executableDir = dirname(process.execPath);
  const resourcesDir = process.resourcesPath;
  const dataRoot = isPackaged
    ? resolvePackagedDataRoot(executableDir)
    : repoRoot;
  const libraryDir = isPackaged
    ? join(dataRoot, "library")
    : join(repoRoot, "library");
  const logsDir = isPackaged ? join(dataRoot, "logs") : join(repoRoot, "logs");
  const runtimeDir = isPackaged
    ? join(resourcesDir, "app-runtime")
    : join(repoRoot, "out", "app-runtime");
  const toolsDir = isPackaged
    ? join(resourcesDir, "tools")
    : join(repoRoot, "tools");
  const allowExternalRuntime = allowExternalRuntimeOverrides(isPackaged);
  const explicitOcrRuntimeDir = allowExternalRuntime
    ? process.env.MANGA_TRANSLATOR_OCR_RUNTIME_DIR?.trim()
    : undefined;
  const ocrRuntimeDir = explicitOcrRuntimeDir || join(dataRoot, "ocr-runtime");
  const llamaServerPath = resolveBundledLlamaServerPath(toolsDir);
  const llamaRuntimeDir = dirname(llamaServerPath);
  const explicitHfHome = process.env.MANGA_TRANSLATOR_HF_HOME?.trim();
  const explicitHubCache =
    process.env.HF_HUB_CACHE?.trim() ||
    process.env.HUGGINGFACE_HUB_CACHE?.trim();
  const hfHomeDir = isPackaged
    ? join(dataRoot, "hf-cache")
    : explicitHfHome || undefined;
  const hfHubCacheDir = isPackaged
    ? join(dataRoot, "hf-cache", "hub")
    : explicitHubCache || undefined;
  const llamaCacheDir = isPackaged ? join(dataRoot, "llama.cpp") : undefined;

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
    llamaServerPath,
    hfHomeDir,
    hfHubCacheDir,
    llamaCacheDir,
  };
}

function allowExternalRuntimeOverrides(isPackaged: boolean): boolean {
  if (!isPackaged) {
    return true;
  }
  return isTruthyEnv(
    process.env.MGT_ALLOW_EXTERNAL_RUNTIME ??
      process.env.MANGA_TRANSLATOR_ALLOW_EXTERNAL_RUNTIME,
  );
}

function isTruthyEnv(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

function llamaServerBinaryName(): string {
  return process.platform === "win32" ? "llama-server.exe" : "llama-server";
}

function bundledLlamaServerCandidates(toolsDir: string): string[] {
  const serverBinary = llamaServerBinaryName();
  const knownRuntimeDirs = [
    "beellama-v0.2.0-cuda13.1",
    "beellama-v0.2.0-cuda12.4",
    "llama-b9547-cuda13.3",
    "llama-b9547-cuda12.4",
    "lemonade-llama-b1291-rocm-gfx120X",
    "lemonade-llama-b1291-rocm-gfx1151",
    "lemonade-llama-b1291-rocm-gfx1150",
    "lemonade-llama-b1291-rocm-gfx110X",
    "lemonade-llama-b1291-rocm-gfx103X",
    "lemonade-llama-b1291-rocm-gfx90a",
    "lemonade-llama-b1291-rocm-gfx908",
    "llama-b9547-vulkan",
    "llama-b9360-cuda13.1",
    "llama-b8833-cuda12.4",
    "llama-b8808-cuda12",
  ];
  const candidates = [
    ...knownRuntimeDirs.map((runtimeDir) =>
      join(toolsDir, runtimeDir, serverBinary),
    ),
    join(toolsDir, serverBinary),
  ];

  try {
    for (const entry of readdirSync(toolsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(join(toolsDir, entry.name, serverBinary));
      }
    }
  } catch {
    // The tools directory may not exist in early dev/build states.
  }

  return Array.from(new Set(candidates));
}

function resolveBundledLlamaServerPath(toolsDir: string): string {
  const candidates = bundledLlamaServerCandidates(toolsDir);
  const existing = candidates.filter((candidate) => existsSync(candidate));
  return (
    existing.find((candidate) => hasBundledGpuBackend(candidate)) ??
    existing[0] ??
    candidates[0]
  );
}

function hasBundledGpuBackend(serverPath: string): boolean {
  const runtimeDir = dirname(serverPath);
  return [
    "ggml-cuda.dll",
    "ggml-cuda-cu12.dll",
    "ggml-cuda-cu13.dll",
    "ggml-hip.dll",
    "ggml-rocm.dll",
    "ggml-vulkan.dll",
  ].some((fileName) => existsSync(join(runtimeDir, fileName)));
}

export function ensureWritableAppDirectories(): AppPaths {
  const paths = getAppPaths();
  migrateLegacyPackagedData(paths);
  if (paths.isPackaged) {
    writeDataRootMarker(paths.dataRoot);
  }
  mkdirSync(paths.libraryDir, { recursive: true });
  mkdirSync(paths.fontsDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  if (paths.hfHomeDir) {
    mkdirSync(paths.hfHomeDir, { recursive: true });
  }
  if (paths.hfHubCacheDir) {
    mkdirSync(paths.hfHubCacheDir, { recursive: true });
  }
  if (paths.llamaCacheDir) {
    mkdirSync(paths.llamaCacheDir, { recursive: true });
  }
  mkdirSync(paths.ocrRuntimeDir, { recursive: true });
  return paths;
}

function migrateLegacyPackagedData(paths: AppPaths): void {
  if (!paths.isPackaged) {
    return;
  }

  for (const legacyDataRoot of legacyPackagedDataRoots(paths)) {
    if (
      resolve(legacyDataRoot) === resolve(paths.dataRoot) ||
      !existsSync(legacyDataRoot)
    ) {
      continue;
    }
    copyDirectoryContentsIfMissing(legacyDataRoot, paths.dataRoot);
  }

  for (const legacyDataRoot of legacyAppDataRoots()) {
    if (
      resolve(legacyDataRoot) === resolve(paths.dataRoot) ||
      !existsSync(legacyDataRoot)
    ) {
      continue;
    }
    copyLegacyUserDataIfMissing(legacyDataRoot, paths.dataRoot);
  }
}

function legacyPackagedDataRoots(paths: AppPaths): string[] {
  return [resolve(join(paths.executableDir, "data"))];
}

function writeDataRootMarker(dataRoot: string): void {
  try {
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(
      join(dataRoot, DATA_ROOT_MARKER_FILE),
      "manga-gemma-translator data root\n",
      "utf8",
    );
  } catch {
    // Marker creation is a safety aid for uninstall cleanup, not a startup requirement.
  }
}

function copyLegacyUserDataIfMissing(
  sourceDir: string,
  targetDir: string,
): void {
  copyFileIfMissing(
    join(sourceDir, "settings.json"),
    join(targetDir, "settings.json"),
  );
  copyDirectoryContentsIfMissing(
    join(sourceDir, "library"),
    join(targetDir, "library"),
  );
  copyDirectoryContentsIfMissing(
    join(sourceDir, "fonts"),
    join(targetDir, "fonts"),
  );
}

function copyDirectoryContentsIfMissing(
  sourceDir: string,
  targetDir: string,
): void {
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

function copyFileIfMissing(sourcePath: string, targetPath: string): void {
  if (!existsSync(sourcePath) || existsSync(targetPath)) {
    return;
  }
  if (!statSync(sourcePath).isFile()) {
    return;
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);
}
