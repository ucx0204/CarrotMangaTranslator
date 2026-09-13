import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { resolvePackagedElectronStoragePaths } from "./electronStoragePaths";

export type StartupWriteAccessResult =
  | { status: "writable" }
  | {
      status: "permission-denied" | "unavailable";
      path: string;
      error: unknown;
    };

/** Probe only app-owned locations; never edit settings, models, or user images. */
export function probeStartupWriteAccess(
  dataRoot: string,
): StartupWriteAccessResult {
  if (!isAbsolute(dataRoot)) {
    return {
      status: "unavailable",
      path: dataRoot,
      error: new Error("The startup data root must be an absolute path."),
    };
  }

  const directories = new Set([
    dataRoot,
    ...Object.values(resolvePackagedElectronStoragePaths(dataRoot)),
    ...[
      "logs",
      "library",
      "models",
      "fonts",
      "ocr-runtime",
      "hf-cache",
      "llama.cpp",
      "codex",
      ".settings-pairs",
    ].map((name) => join(dataRoot, name)),
  ]);
  for (const directory of directories) {
    try {
      probeWritableDirectory(directory);
    } catch (error) {
      return {
        status: isPermissionFailure(error)
          ? "permission-denied"
          : "unavailable",
        path: directory,
        error,
      };
    }
  }
  return { status: "writable" };
}

function probeWritableDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true });
  const scratch = mkdtempSync(join(directory, ".mgt-write-probe-"));
  const source = join(scratch, "source");
  const destination = join(scratch, "destination");
  const failures: unknown[] = [];
  try {
    writeFileSync(source, "startup write probe\n", { flag: "wx" });
    writeFileSync(destination, "startup replace probe\n", { flag: "wx" });
    renameSync(source, destination);
    unlinkSync(destination);
  } catch (error) {
    failures.push(error);
  }

  // Remove only our own files and empty directory, never recursively delete.
  for (const file of [source, destination]) {
    collectCleanupFailure(() => unlinkSync(file), failures);
  }
  collectCleanupFailure(() => rmdirSync(scratch), failures);
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      `Startup write probe failed: ${directory}`,
    );
  }
}

function collectCleanupFailure(cleanup: () => void, failures: unknown[]): void {
  try {
    cleanup();
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      failures.push(error);
    }
  }
}

function isPermissionFailure(error: unknown): boolean {
  if (error instanceof AggregateError) {
    const [primary, ...cleanup]: unknown[] = error.errors;
    return (
      isPermissionFailure(primary) &&
      cleanup.every(
        (failure) =>
          isPermissionFailure(failure) || errorCode(failure) === "ENOTEMPTY",
      )
    );
  }
  return ["EACCES", "EPERM"].includes(errorCode(error) ?? "");
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}
