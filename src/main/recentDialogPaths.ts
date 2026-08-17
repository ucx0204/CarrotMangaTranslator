import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { logStateStoreError } from "./stateStoreDiagnostics";

const RECENT_DIALOG_PATHS_FILE = "recent-dialog-paths.json";

export const recentDialogPathKeys = {
  imageImport: "imageImport",
  imageFolderImport: "imageFolderImport",
  archiveImport: "archiveImport",
  archiveFolderImport: "archiveFolderImport",
  workShareImport: "workShareImport",
  workShareExport: "workShareExport",
  customFontImport: "customFontImport",
  localModel: "localModel",
  localMmproj: "localMmproj",
  vertexServiceAccount: "vertexServiceAccount",
  pageImageExport: "pageImageExport",
  reviewTextExport: "reviewTextExport",
  plainTextExport: "plainTextExport",
} as const;

export type RecentDialogPathKey =
  (typeof recentDialogPathKeys)[keyof typeof recentDialogPathKeys];

export type RecentDialogLocation = {
  key: RecentDialogPathKey;
  kind: "file" | "directory";
  path: string;
};

type RecentDialogPaths = Partial<Record<RecentDialogPathKey, string>>;

const validKeys = new Set<RecentDialogPathKey>(
  Object.values(recentDialogPathKeys),
);
const stores = new Map<string, RecentDialogPathStore>();

export function getRecentDialogDirectory(
  dataRoot: string,
  key: RecentDialogPathKey,
): string | undefined {
  return getStore(dataRoot).getDirectory(key);
}

export function getRecentDialogFileDefaultPath(
  dataRoot: string,
  key: RecentDialogPathKey,
  defaultName: string,
): string {
  const directory = getRecentDialogDirectory(dataRoot, key);
  return directory ? join(directory, defaultName) : defaultName;
}

export function rememberRecentDialogDirectory(
  dataRoot: string,
  key: RecentDialogPathKey,
  directoryPath: string,
): void {
  getStore(dataRoot).rememberDirectory(key, directoryPath);
}

export function rememberRecentDialogFile(
  dataRoot: string,
  key: RecentDialogPathKey,
  filePath: string,
): void {
  getStore(dataRoot).rememberDirectory(key, dirname(filePath));
}

export function rememberRecentDialogLocation(
  dataRoot: string,
  location: RecentDialogLocation,
): void {
  if (location.kind === "file") {
    rememberRecentDialogFile(dataRoot, location.key, location.path);
    return;
  }
  rememberRecentDialogDirectory(dataRoot, location.key, location.path);
}

function getStore(dataRoot: string): RecentDialogPathStore {
  const normalizedRoot = resolve(dataRoot);
  let store = stores.get(normalizedRoot);
  if (!store) {
    store = new RecentDialogPathStore(normalizedRoot);
    stores.set(normalizedRoot, store);
  }
  return store;
}

class RecentDialogPathStore {
  private readonly filePath: string;
  private directories: RecentDialogPaths;

  constructor(dataRoot: string) {
    this.filePath = join(dataRoot, RECENT_DIALOG_PATHS_FILE);
    this.directories = this.read();
  }

  getDirectory(key: RecentDialogPathKey): string | undefined {
    const directoryPath = this.directories[key];
    return directoryPath
      ? findNearestExistingDirectory(directoryPath)
      : undefined;
  }

  rememberDirectory(key: RecentDialogPathKey, directoryPath: string): void {
    if (!isAbsolute(directoryPath) || !isExistingDirectory(directoryPath)) {
      return;
    }
    this.directories = { ...this.directories, [key]: directoryPath };
    this.write();
  }

  private read(): RecentDialogPaths {
    try {
      if (!existsSync(this.filePath)) {
        return {};
      }
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
      if (!isRecord(parsed)) {
        return {};
      }
      const directories: RecentDialogPaths = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (
          validKeys.has(key as RecentDialogPathKey) &&
          typeof value === "string" &&
          isAbsolute(value)
        ) {
          directories[key as RecentDialogPathKey] = value;
        }
      }
      return directories;
    } catch (error) {
      logStateStoreError("Failed to read recent dialog paths", {
        filePath: this.filePath,
        error,
      });
      return {};
    }
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(
        this.filePath,
        `${JSON.stringify(this.directories, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      logStateStoreError("Failed to write recent dialog paths", {
        filePath: this.filePath,
        error,
      });
    }
  }
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (_error) {
    return false;
  }
}

function findNearestExistingDirectory(path: string): string | undefined {
  let candidate = path;
  while (true) {
    if (isExistingDirectory(candidate)) {
      return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      return undefined;
    }
    candidate = parent;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
