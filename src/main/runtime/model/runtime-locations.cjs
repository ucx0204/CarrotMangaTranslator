// @ts-check
const { existsSync } = require("node:fs");
const path = require("node:path");

const {
  bundledServerCandidates,
  resolveBundledServerPath,
} = require("../resolve-llama-runtime.cjs");
const { runtimeOverrideEnv } = require("../simple-page-child-env.cjs");
const { resolveWorkingDir } = require("../simple-page-cache-paths.cjs");
const {
  resolveWindowsLlamaRuntimeMaxRelativePathLength,
} = require("../simple-page-llama-runtimes.cjs");
const {
  hasCudaRuntimeBackend,
  hasLlamaRuntimeBackend,
  isRuntimeCandidate,
  serverBinaryName,
} = require("./runtime-files.cjs");
const {
  isBuiltInGemmaRuntimeModel,
  resolvePreferredLlamaRuntime,
} = require("./runtime-profile.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { managedToolsDir?: string | null; toolsDir?: string | null }} RuntimePathOptions */

const WINDOWS_LEGACY_PATH_CEILING = 252;
const WINDOWS_SHORT_MANAGED_TOOLS_DIR = path.join("MGT", "tools");
const COMPACT_RUNTIME_SIBLING = ".s-0000000000000000";
const DOWNLOAD_INTEGRITY_SUFFIX = ".mgt-sha256.json";
const CLAIMED_RUNTIME_ARCHIVE_PREFIX = ".mgt-llama-archive-";
const CLAIMED_RUNTIME_ARCHIVE_TOKEN = "0".repeat(32);

/** @param {RuntimePathOptions} [options] */
function resolveToolsDir(options = {}) {
  const candidates = /** @type {string[]} */ (
    [
      options.toolsDir,
      runtimeOverrideEnv("MANGA_TRANSLATOR_TOOLS_DIR", options),
      path.resolve(__dirname, "..", "..", "tools"),
      path.resolve(__dirname, "..", "..", "..", "tools"),
    ].filter(
      (candidate) => typeof candidate === "string" && candidate.length > 0,
    )
  );
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

/** @param {RuntimePathOptions} [options] */
function resolveManagedToolsDir(options = {}) {
  const explicit = String(
    options.managedToolsDir ??
      runtimeOverrideEnv("MANGA_TRANSLATOR_MANAGED_TOOLS_DIR", options) ??
      "",
  ).trim();
  const defaultDir = path.join(resolveWorkingDir(options), "tools");
  if (process.platform !== "win32") return explicit || defaultDir;
  const runtime = resolvePreferredLlamaRuntime(options);
  if (explicit) {
    assertWindowsManagedToolsPath(explicit, runtime, true);
    return explicit;
  }
  if (windowsManagedToolsPathIsSafe(defaultDir, runtime)) return defaultDir;
  const localAppData = String(process.env.LOCALAPPDATA || "").trim();
  const fallbackDir = localAppData
    ? path.join(localAppData, WINDOWS_SHORT_MANAGED_TOOLS_DIR)
    : "";
  if (fallbackDir && windowsManagedToolsPathIsSafe(fallbackDir, runtime)) {
    return fallbackDir;
  }
  throw createManagedToolsPathError(defaultDir, fallbackDir, runtime, false);
}

/** @param {RuntimePathOptions} [options] */
function resolveManagedToolsSearchDirs(options = {}) {
  const explicit = String(
    options.managedToolsDir ??
      runtimeOverrideEnv("MANGA_TRANSLATOR_MANAGED_TOOLS_DIR", options) ??
      "",
  ).trim();
  if (explicit) return [resolveManagedToolsDir(options)];
  const primary = resolveManagedToolsDir(options);
  const legacyDefault = path.join(resolveWorkingDir(options), "tools");
  if (process.platform !== "win32") {
    return uniqueRuntimeDirs([primary, legacyDefault]);
  }
  const localAppData = String(process.env.LOCALAPPDATA || "").trim();
  const fallbackCandidate = localAppData
    ? path.join(localAppData, WINDOWS_SHORT_MANAGED_TOOLS_DIR)
    : null;
  const runtime = resolvePreferredLlamaRuntime(options);
  const shortFallback =
    fallbackCandidate &&
    windowsManagedToolsPathIsSafe(fallbackCandidate, runtime)
      ? fallbackCandidate
      : null;
  const safeLegacyDefault = windowsManagedToolsPathIsSafe(
    legacyDefault,
    runtime,
  )
    ? legacyDefault
    : null;
  return uniqueRuntimeDirs([primary, safeLegacyDefault, shortFallback]);
}

/** @param {RuntimePathOptions} [options] */
function resolveLlamaRuntimeSearchDirs(options = {}) {
  return uniqueRuntimeDirs([
    ...resolveManagedToolsSearchDirs(options),
    resolveToolsDir(options),
  ]);
}

/** @param {Array<string | null | undefined>} dirs @returns {string[]} */
function uniqueRuntimeDirs(dirs) {
  const seen = new Set();
  /** @type {string[]} */
  const result = [];
  for (const dir of dirs) {
    if (!dir) continue;
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(dir);
  }
  return result;
}

/** @param {string} managedToolsDir @param {{ archive?: unknown; archives?: Array<{ archive?: unknown }>; dir: string; id?: unknown; requiredFiles?: Array<string | string[]> }} runtime */
function windowsManagedToolsPathIsSafe(managedToolsDir, runtime) {
  if (process.platform !== "win32") return true;
  return managedRuntimePathCandidates(managedToolsDir, runtime).every(
    ({ filePath }) =>
      path.resolve(filePath).length < WINDOWS_LEGACY_PATH_CEILING,
  );
}

/** @param {string} managedToolsDir @param {{ archive?: unknown; archives?: Array<{ archive?: unknown }>; dir: string; id?: unknown; requiredFiles?: Array<string | string[]> }} runtime @param {boolean} explicit */
function assertWindowsManagedToolsPath(managedToolsDir, runtime, explicit) {
  if (windowsManagedToolsPathIsSafe(managedToolsDir, runtime)) return;
  throw createManagedToolsPathError(managedToolsDir, "", runtime, explicit);
}

/** @param {string} managedToolsDir @param {{ archive?: unknown; archives?: Array<{ archive?: unknown }>; dir: string; id?: unknown; requiredFiles?: Array<string | string[]> }} runtime */
function managedRuntimePathCandidates(managedToolsDir, runtime) {
  const maximumRelativePath = "x".repeat(
    resolveWindowsLlamaRuntimeMaxRelativePathLength(runtime),
  );
  const archives = Array.isArray(runtime.archives)
    ? runtime.archives
    : runtime.archive
      ? [{ archive: runtime.archive }]
      : [];
  return [
    {
      kind: "final-runtime-entry",
      filePath: path.join(managedToolsDir, runtime.dir, maximumRelativePath),
    },
    {
      kind: "staging-runtime-entry",
      filePath: path.join(
        managedToolsDir,
        COMPACT_RUNTIME_SIBLING,
        maximumRelativePath,
      ),
    },
    ...archives.map((archive) => ({
      kind: "download-integrity-marker",
      filePath: path.join(
        managedToolsDir,
        ".downloads",
        `${String(archive.archive || "runtime.zip")}${DOWNLOAD_INTEGRITY_SUFFIX}`,
      ),
    })),
    ...archives.map((archive) => ({
      kind: "claimed-runtime-archive",
      filePath: path.join(
        managedToolsDir,
        ".downloads",
        `${CLAIMED_RUNTIME_ARCHIVE_PREFIX}${CLAIMED_RUNTIME_ARCHIVE_TOKEN}${runtimeArchiveSuffix(archive.archive)}`,
      ),
    })),
  ];
}

/** @param {unknown} archive */
function runtimeArchiveSuffix(archive) {
  const fileName = String(archive || "runtime.zip");
  return fileName.toLowerCase().endsWith(".tar.gz")
    ? ".tar.gz"
    : path.extname(fileName);
}

/** @param {string} requestedDir @param {string} fallbackDir @param {{ archive?: unknown; archives?: Array<{ archive?: unknown }>; dir: string; id?: unknown; requiredFiles?: Array<string | string[]> }} runtime @param {boolean} explicit */
function createManagedToolsPathError(
  requestedDir,
  fallbackDir,
  runtime,
  explicit,
) {
  const longest = longestManagedRuntimePath(requestedDir, runtime);
  const fallbackLongest = fallbackDir
    ? longestManagedRuntimePath(fallbackDir, runtime)
    : null;
  return Object.assign(
    new Error(
      explicit
        ? "The configured Windows managed-tools directory is too long for the selected llama runtime."
        : "No Windows managed-tools directory is short enough for the selected llama runtime.",
    ),
    {
      managedToolsDir: path.resolve(requestedDir),
      fallbackManagedToolsDir: fallbackDir ? path.resolve(fallbackDir) : null,
      runtime: runtime.id,
      derivedPath: longest ? path.resolve(longest.filePath) : null,
      derivedPathKind: longest?.kind,
      derivedPathLength: longest ? path.resolve(longest.filePath).length : null,
      fallbackDerivedPath: fallbackLongest
        ? path.resolve(fallbackLongest.filePath)
        : null,
      fallbackDerivedPathLength: fallbackLongest
        ? path.resolve(fallbackLongest.filePath).length
        : null,
      windowsPathCeiling: WINDOWS_LEGACY_PATH_CEILING,
      windowsPathUnsafe: true,
      nonRetriable: true,
    },
  );
}

/** @param {string} managedToolsDir @param {{ archive?: unknown; archives?: Array<{ archive?: unknown }>; dir: string; id?: unknown; requiredFiles?: Array<string | string[]> }} runtime */
function longestManagedRuntimePath(managedToolsDir, runtime) {
  return managedRuntimePathCandidates(managedToolsDir, runtime).sort(
    (left, right) =>
      path.resolve(right.filePath).length - path.resolve(left.filePath).length,
  )[0];
}

/** @param {RuntimePathOptions} options */
function findExistingRuntimeCandidates(options) {
  return resolveLlamaRuntimeSearchDirs(options).flatMap((dir) =>
    bundledServerCandidates(dir).filter((candidate) => existsSync(candidate)),
  );
}

/** @param {string[]} candidates @param {{ backend?: string }} runtime */
function findCompatibleFallback(candidates, runtime) {
  return (
    candidates.find((candidate) =>
      hasLlamaRuntimeBackend(path.dirname(candidate), runtime.backend),
    ) ||
    candidates.find((candidate) =>
      hasCudaRuntimeBackend(path.dirname(candidate)),
    ) ||
    candidates[0]
  );
}

/** @param {RuntimePathOptions} [options] */
function defaultServerPath(options = {}) {
  const candidates = findExistingRuntimeCandidates(options);
  const runtime = resolvePreferredLlamaRuntime(options);
  const preferred = candidates.find((candidate) =>
    isRuntimeCandidate(candidate, runtime),
  );
  if (preferred) return preferred;
  const managedPath = path.join(
    resolveManagedToolsDir(options),
    runtime.dir,
    serverBinaryName(),
  );
  if (isBuiltInGemmaRuntimeModel(options) || !existsSync(managedPath))
    return managedPath;
  return (
    findCompatibleFallback(candidates, runtime) ||
    resolveBundledServerPath(
      resolveLlamaRuntimeSearchDirs(options)[0] || resolveToolsDir(options),
    )
  );
}

module.exports = {
  defaultServerPath,
  resolveLlamaRuntimeSearchDirs,
  resolveManagedToolsDir,
  resolveManagedToolsSearchDirs,
  resolveToolsDir,
};
