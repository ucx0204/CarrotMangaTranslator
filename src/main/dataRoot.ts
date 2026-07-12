import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const APP_DATA_DIR_NAME = "manga-gemma-translator";
export const DATA_ROOT_POINTER_FILE = "data-root.txt";
export const DATA_ROOT_MARKER_FILE = ".manga-gemma-translator-data";

export function resolvePackagedDataRoot(executableDir: string): string {
  const explicit = normalizeDataRoot(process.env.MANGA_TRANSLATOR_DATA_ROOT);
  if (explicit) {
    return explicit;
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
