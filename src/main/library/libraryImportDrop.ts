import { stat } from "node:fs/promises";
import { basename, isAbsolute, normalize } from "node:path";
import type { DroppedImportPreviewResponse } from "../../shared/importTypes";
import { isSupportedArchivePath } from "../libraryStore/importSources";
import { isSupportedImagePath } from "../libraryStore/storage";

type DroppedImportRejection = Extract<
  DroppedImportPreviewResponse,
  { status: "rejected" }
>;

export type DroppedImportSource =
  | {
      status: "accepted";
      kind: "images";
      filePaths: string[];
    }
  | {
      status: "accepted";
      kind: "folder";
      folderPath: string;
    }
  | {
      status: "accepted";
      kind: "archive";
      archivePath: string;
    };

export type DroppedImportClassification =
  | DroppedImportSource
  | DroppedImportRejection;

type InspectedDropPath = {
  path: string;
  kind: "file" | "directory" | "unsupported";
};

export async function classifyDroppedImportPaths(
  filePaths: string[],
): Promise<DroppedImportClassification> {
  const uniquePaths = deduplicatePaths(filePaths);
  if (uniquePaths.length === 0) {
    return { status: "rejected", reason: "empty" };
  }

  const entries = await Promise.all(uniquePaths.map(inspectDropPath));
  const directories = entries.filter((entry) => entry.kind === "directory");
  if (directories.length > 0) {
    if (entries.length !== 1 || directories.length !== 1) {
      return rejectWithExamples("folder-must-be-alone", entries);
    }
    return {
      status: "accepted",
      kind: "folder",
      folderPath: directories[0].path,
    };
  }

  const archives = entries.filter(
    (entry) => entry.kind === "file" && isSupportedArchivePath(entry.path),
  );
  if (archives.length > 0) {
    if (entries.length !== 1 || archives.length !== 1) {
      return rejectWithExamples("archive-must-be-alone", entries);
    }
    return {
      status: "accepted",
      kind: "archive",
      archivePath: archives[0].path,
    };
  }

  const unsupported = entries.filter(
    (entry) => entry.kind !== "file" || !isSupportedImagePath(entry.path),
  );
  if (unsupported.length > 0) {
    return rejectWithExamples("unsupported-files", unsupported);
  }

  return {
    status: "accepted",
    kind: "images",
    filePaths: entries.map((entry) => entry.path),
  };
}

async function inspectDropPath(filePath: string): Promise<InspectedDropPath> {
  if (!isAbsolute(filePath)) {
    return { path: filePath, kind: "unsupported" };
  }
  try {
    const info = await stat(filePath);
    if (info.isFile()) {
      return { path: filePath, kind: "file" };
    }
    if (info.isDirectory()) {
      return { path: filePath, kind: "directory" };
    }
  } catch (error) {
    void error;
    return { path: filePath, kind: "unsupported" };
  }
  return { path: filePath, kind: "unsupported" };
}

function deduplicatePaths(filePaths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const filePath of filePaths) {
    const normalized = normalize(filePath);
    const key =
      process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(filePath);
    }
  }
  return unique;
}

function rejectWithExamples(
  reason: DroppedImportRejection["reason"],
  entries: InspectedDropPath[],
): DroppedImportRejection {
  return {
    status: "rejected",
    reason,
    count: entries.length,
    names: entries.slice(0, 3).map((entry) => safeBasename(entry.path)),
  };
}

function safeBasename(filePath: string): string {
  const name = basename(filePath) || filePath;
  return name.length <= 260 ? name : `${name.slice(0, 259)}…`;
}
