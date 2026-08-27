import { app } from "electron";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
  codexHomeDir?: string;
  codexWorkspaceDir?: string;
  hfHomeDir?: string;
  hfHubCacheDir?: string;
  llamaCacheDir?: string;
};

type AppPathRoots = Pick<
  AppPaths,
  "dataRoot" | "executableDir" | "isPackaged" | "repoRoot" | "resourcesDir"
>;

type ModelCachePaths = Pick<
  AppPaths,
  "hfHomeDir" | "hfHubCacheDir" | "llamaCacheDir"
>;

let cachedAppPaths: AppPaths | null = null;

function isRunningPackaged(): boolean {
  return app.isPackaged || __dirname.includes("app.asar");
}

/**
 * App paths are process-scoped startup configuration. Bootstrap configures
 * Electron storage before loading the main entry, so resolving this snapshot
 * once avoids repeating synchronous runtime discovery in library and log hot
 * paths while preserving an explicit getter at call sites.
 */
export function getAppPaths(): AppPaths {
  cachedAppPaths ??= resolveAppPaths();
  return cachedAppPaths;
}

function resolveAppPaths(): AppPaths {
  const roots = resolveAppPathRoots();
  const libraryDir = resolveWritableDataDir(roots, "library");
  const logsDir = resolveWritableDataDir(roots, "logs");
  const runtimeDir = resolveRuntimeDir(roots);
  const toolsDir = resolveToolsDir(roots);
  const ocrRuntimeDir = resolveOcrRuntimeDir(roots);
  const llamaServerPath = resolveBundledLlamaServerPath(toolsDir);
  const llamaRuntimeDir = dirname(llamaServerPath);
  const modelCachePaths = resolveModelCachePaths(roots);

  return {
    ...roots,
    settingsPath: join(roots.dataRoot, "settings.json"),
    libraryDir,
    fontsDir: join(roots.dataRoot, "fonts"),
    logsDir,
    logFile: join(logsDir, "app.log"),
    runtimeDir,
    toolsDir,
    ocrRuntimeDir,
    llamaRuntimeDir,
    llamaServerPath,
    codexHomeDir: join(roots.dataRoot, "codex"),
    codexWorkspaceDir: join(
      tmpdir(),
      "carrot-manga-translator-codex-workspace",
    ),
    ...modelCachePaths,
  };
}

function resolveAppPathRoots(): AppPathRoots {
  const isPackaged = isRunningPackaged();
  const repoRoot = resolve(__dirname, "../..");
  const executableDir = dirname(process.execPath);
  const resourcesDir = process.resourcesPath;
  const dataRoot = isPackaged
    ? resolvePackagedDataRoot(executableDir, {
        platform: process.platform,
        appDataDir: app.getPath("appData"),
      })
    : repoRoot;

  return { dataRoot, executableDir, isPackaged, repoRoot, resourcesDir };
}

function resolveWritableDataDir(
  paths: Pick<AppPathRoots, "dataRoot" | "isPackaged" | "repoRoot">,
  name: string,
): string {
  return join(paths.isPackaged ? paths.dataRoot : paths.repoRoot, name);
}

function resolveRuntimeDir(paths: AppPathRoots): string {
  return paths.isPackaged
    ? join(paths.resourcesDir, "app-runtime")
    : join(paths.repoRoot, "out", "app-runtime");
}

function resolveToolsDir(paths: AppPathRoots): string {
  return paths.isPackaged
    ? join(paths.resourcesDir, "tools")
    : join(paths.repoRoot, "tools");
}

function resolveOcrRuntimeDir(paths: AppPathRoots): string {
  const dataRoot = paths.dataRoot;
  const explicitOcrRuntimeDir = allowExternalRuntimeOverrides(paths.isPackaged)
    ? process.env.MANGA_TRANSLATOR_OCR_RUNTIME_DIR?.trim()
    : undefined;
  const ocrRuntimeDir = explicitOcrRuntimeDir || join(dataRoot, "ocr-runtime");
  return ocrRuntimeDir;
}

function resolveModelCachePaths(paths: AppPathRoots): ModelCachePaths {
  const explicitHfHome = process.env.MANGA_TRANSLATOR_HF_HOME?.trim();
  const explicitHubCache =
    process.env.HF_HUB_CACHE?.trim() ||
    process.env.HUGGINGFACE_HUB_CACHE?.trim();
  return {
    hfHomeDir: paths.isPackaged
      ? join(paths.dataRoot, "hf-cache")
      : explicitHfHome || undefined,
    hfHubCacheDir: paths.isPackaged
      ? join(paths.dataRoot, "hf-cache", "hub")
      : explicitHubCache || undefined,
    llamaCacheDir: paths.isPackaged
      ? join(paths.dataRoot, "llama.cpp")
      : undefined,
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
    "llama-b10621-metal-arm64",
    "beellama-v0.3.1-metal-arm64",
    "llama-b9547-metal-arm64",
    "beellama-v0.3.1-hip-radeon",
    "beellama-v0.2.0-cuda13.1",
    "beellama-v0.2.0-cuda12.4",
    "llama-b9547-cuda13.3",
    "llama-b9547-cuda12.4",
    "llama-b9553-cuda13.3",
    "llama-b9553-cuda12.4",
    "llama-b10621-cuda13.3",
    "llama-b10621-cuda12.4",
    "lemonade-llama-b1317-rocm-gfx120X",
    "lemonade-llama-b1317-rocm-gfx1151",
    "lemonade-llama-b1317-rocm-gfx1150",
    "lemonade-llama-b1317-rocm-gfx110X",
    "lemonade-llama-b1317-rocm-gfx103X",
    "lemonade-llama-b1317-rocm-gfx90a",
    "lemonade-llama-b1317-rocm-gfx908",
    "lemonade-llama-b1316-rocm-gfx120X",
    "lemonade-llama-b1316-rocm-gfx1151",
    "lemonade-llama-b1316-rocm-gfx1150",
    "lemonade-llama-b1316-rocm-gfx110X",
    "lemonade-llama-b1316-rocm-gfx103X",
    "lemonade-llama-b1316-rocm-gfx90a",
    "lemonade-llama-b1316-rocm-gfx908",
    "lemonade-llama-b1291-rocm-gfx120X",
    "lemonade-llama-b1291-rocm-gfx1151",
    "lemonade-llama-b1291-rocm-gfx1150",
    "lemonade-llama-b1291-rocm-gfx110X",
    "lemonade-llama-b1291-rocm-gfx103X",
    "lemonade-llama-b1291-rocm-gfx90a",
    "lemonade-llama-b1291-rocm-gfx908",
    "llama-b9547-vulkan",
    "llama-b10621-vulkan",
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
  } catch (_error) {
    // error-policy-allow: the optional tools directory may not exist in early dev/build states.
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
  const optionalRuntimeDirectories = [
    paths.hfHomeDir,
    paths.hfHubCacheDir,
    paths.llamaCacheDir,
    paths.codexHomeDir,
    paths.codexWorkspaceDir,
  ];
  for (const directory of optionalRuntimeDirectories) {
    if (directory) {
      mkdirSync(directory, { recursive: true });
    }
  }
  mkdirSync(paths.ocrRuntimeDir, { recursive: true });
  return paths;
}

export function migrateLegacyPackagedData(
  paths: AppPaths,
  legacyUserDataRoots: readonly string[] = legacyAppDataRoots(),
): void {
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

  for (const legacyDataRoot of legacyUserDataRoots) {
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
  } catch (_error) {
    // error-policy-allow: marker creation is a safety aid, not a startup requirement.
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
