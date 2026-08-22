import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const APP_DATA_DIR_NAME = "manga-gemma-translator";
export const DATA_ROOT_POINTER_FILE = "data-root.txt";
export const DATA_ROOT_MARKER_FILE = ".manga-gemma-translator-data";
export const PACKAGED_MAIN_RUNTIME_SMOKE_MARKER =
  "packaged-main-runtime-smoke.json";

export type PackagedDataRootOptions = {
  platform?: NodeJS.Platform;
  appDataDir?: string;
};

export function resolvePackagedDataRoot(
  executableDir: string,
  options: PackagedDataRootOptions = {},
): string {
  const explicit = normalizeDataRoot(process.env.MANGA_TRANSLATOR_DATA_ROOT);
  if (explicit) {
    return explicit;
  }

  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    const appDataDir = normalizeDataRoot(options.appDataDir);
    if (!appDataDir) {
      throw new Error("macOS app data directory is unavailable");
    }
    return join(appDataDir, APP_DATA_DIR_NAME);
  }

  const configured = readDataRootPointer(executableDir);
  if (configured) {
    return configured;
  }

  const legacyInstallDataRoot = join(executableDir, "data");
  if (existsSync(legacyInstallDataRoot)) {
    return legacyInstallDataRoot;
  }

  const existingLegacyAppDataRoot = findExistingLegacyAppDataRoot();
  if (existingLegacyAppDataRoot) {
    return existingLegacyAppDataRoot;
  }

  return legacyInstallDataRoot;
}

/**
 * Keeps the packaged smoke marker inside the canonical data root while
 * accepting Windows path aliases (for example RUNNER~1 versus RunnerAdmin).
 */
export function resolvePackagedMainRuntimeSmokeMarker(
  dataRoot: string,
  requestedMarker: string | undefined,
): string {
  const requestedText = requestedMarker?.trim();
  if (!requestedText) {
    throw new Error("Packaged main runtime smoke marker is missing.");
  }

  const canonicalDataRoot = realpathSync.native(resolve(dataRoot));
  const requestedPath = resolve(requestedText);
  const canonicalRequestedParent = realpathSync.native(dirname(requestedPath));
  if (
    basename(requestedPath) !== PACKAGED_MAIN_RUNTIME_SMOKE_MARKER ||
    canonicalRequestedParent !== canonicalDataRoot
  ) {
    throw new Error(
      `Packaged main runtime smoke marker must be ${join(
        canonicalDataRoot,
        PACKAGED_MAIN_RUNTIME_SMOKE_MARKER,
      )}.`,
    );
  }

  return join(canonicalDataRoot, PACKAGED_MAIN_RUNTIME_SMOKE_MARKER);
}

function readDataRootPointer(executableDir: string): string | null {
  const pointerPath = join(executableDir, DATA_ROOT_POINTER_FILE);
  try {
    if (!existsSync(pointerPath)) {
      return null;
    }
    const raw = readFileSync(pointerPath, "utf8");
    return normalizeDataRoot(raw, executableDir);
  } catch (_error) {
    return null;
  }
}

export function legacyAppDataRoots(): string[] {
  const roots: string[] = [];
  const addRoot = (base: string | undefined, appDirName: string) => {
    const text = base?.trim();
    if (text) {
      roots.push(join(text, appDirName));
    }
  };

  addRoot(process.env.LOCALAPPDATA, APP_DATA_DIR_NAME);
  addRoot(process.env.APPDATA, APP_DATA_DIR_NAME);
  addRoot(process.env.LOCALAPPDATA, "망가번역기");
  addRoot(process.env.APPDATA, "망가번역기");
  return Array.from(new Set(roots.map((root) => resolve(root))));
}

function findExistingLegacyAppDataRoot(): string | null {
  for (const root of legacyAppDataRoots()) {
    if (hasExistingAppData(root)) {
      return root;
    }
  }
  return null;
}

function hasExistingAppData(root: string): boolean {
  return [
    "settings.json",
    "library",
    "hf-cache",
    "ocr-runtime",
    "models",
    "fonts",
  ].some((entryName) => existsSync(join(root, entryName)));
}

function normalizeDataRoot(value: unknown, baseDir?: string): string | null {
  const text = String(value ?? "")
    .trim()
    .replace(/^["']|["']$/g, "");
  if (!text) {
    return null;
  }
  return baseDir ? resolve(baseDir, text) : resolve(text);
}
