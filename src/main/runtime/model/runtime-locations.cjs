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
  return explicit || path.join(resolveWorkingDir(options), "tools");
}

/** @param {RuntimePathOptions} [options] */
function resolveLlamaRuntimeSearchDirs(options = {}) {
  const seen = new Set();
  return [resolveManagedToolsDir(options), resolveToolsDir(options)].filter(
    (dir) => {
      if (!dir) return false;
      const key = path.resolve(dir).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  );
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
  resolveToolsDir,
};
