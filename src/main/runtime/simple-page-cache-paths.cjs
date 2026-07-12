// @ts-check
/** @typedef {import("./runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
const { createHash } = require("node:crypto");
const path = require("node:path");

const { runtimeOverrideEnv } = require("./simple-page-child-env.cjs");

/**
 * @param {RuntimeOptions} [options]
 * @returns {string}
 */
function resolveWorkingDir(options = {}) {
  return options.workingDir || process.cwd();
}

/**
 * @returns {string | null}
 */
function defaultHfHomeDir() {
  const xdgCacheHome = String(process.env.XDG_CACHE_HOME ?? "").trim();
  if (xdgCacheHome) {
    return path.join(xdgCacheHome, "huggingface");
  }

  const homeDir = String(
    process.env.USERPROFILE ?? process.env.HOME ?? "",
  ).trim();
  if (!homeDir) {
    return null;
  }

  return path.join(homeDir, ".cache", "huggingface");
}

/**
 * @param {RuntimeOptions} [options]
 * @returns {string | null}
 */
function resolveHfHomeDir(options = {}) {
  return (
    options.hfHomeDir ||
    runtimeOverrideEnv("HF_HOME", options) ||
    runtimeOverrideEnv("MANGA_TRANSLATOR_HF_HOME", options) ||
    defaultHfHomeDir()
  );
}

/**
 * @param {RuntimeOptions} [options]
 * @returns {string | null}
 */
function resolveHubCacheDir(options = {}) {
  const hfHomeDir = resolveHfHomeDir(options);
  return (
    options.hfHubCacheDir ||
    runtimeOverrideEnv("HF_HUB_CACHE", options) ||
    runtimeOverrideEnv("HUGGINGFACE_HUB_CACHE", options) ||
    (hfHomeDir ? path.join(hfHomeDir, "hub") : null)
  );
}

/**
 * @param {RuntimeOptions} [options]
 * @returns {string | null}
 */
function resolveLlamaCppCacheDir(options = {}) {
  const explicit = String(
    options.llamaCacheDir ??
      runtimeOverrideEnv("MANGA_TRANSLATOR_LLAMA_CACHE_DIR", options) ??
      "",
  ).trim();
  if (explicit) {
    return explicit;
  }
  if (process.platform === "win32") {
    const localAppData = String(process.env.LOCALAPPDATA ?? "").trim();
    return localAppData
      ? path.join(localAppData, "manga-gemma-translator", "llama.cpp")
      : null;
  }
  const xdgCacheHome = String(process.env.XDG_CACHE_HOME ?? "").trim();
  if (xdgCacheHome) {
    return path.join(xdgCacheHome, "manga-gemma-translator", "llama.cpp");
  }
  const homeDir = String(process.env.HOME ?? "").trim();
  return homeDir
    ? path.join(homeDir, ".cache", "manga-gemma-translator", "llama.cpp")
    : null;
}

/**
 * @param {string} repoId
 * @returns {string}
 */
function safeHfRepoId(repoId) {
  const normalized = String(repoId ?? "")
    .replace(/\\/g, "/")
    .trim();
  const parts = normalized.split("/");
  if (
    !normalized ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part),
    )
  ) {
    throw new Error(`Invalid Hugging Face repository ID: ${repoId}`);
  }
  return parts.join("/");
}

/**
 * @param {string} repoId
 * @param {string} hubCacheDir
 * @returns {string}
 */
function repoCacheDir(repoId, hubCacheDir) {
  return path.join(
    hubCacheDir,
    `models--${safeHfRepoId(repoId).replace(/\//g, "--")}`,
  );
}

/**
 * @param {string} file
 * @returns {string}
 */
function safeHfRelativePath(file) {
  const normalized = String(file ?? "")
    .replace(/\\/g, "/")
    .trim();
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Invalid Hugging Face file path: ${file}`);
  }
  return normalized.split("/").join(path.sep);
}

/**
 * App-managed Hugging Face files use a compact content key instead of
 * repeating the (potentially very long) repository and file names. Native
 * llama runtimes on Windows may still be limited by MAX_PATH even though
 * Node itself can read the original cache path.
 *
 * @param {string} repo
 * @param {string} file
 * @returns {string}
 */
function managedHfFileName(repo, file) {
  const safeFile = safeHfRelativePath(file);
  const normalizedFile = safeFile.split(path.sep).join("/");
  const digest = createHash("sha256")
    .update(safeHfRepoId(repo))
    .update("\0")
    .update(normalizedFile)
    .digest("hex")
    .slice(0, 32);
  const extension = path.extname(safeFile);
  return `${digest}${extension && extension.length <= 12 ? extension : ".bin"}`;
}

/**
 * @param {RuntimeOptions} [options]
 * @param {string | null | undefined} [repo]
 * @param {string | null | undefined} [file]
 * @returns {string | null}
 */
function resolveManagedHfFilePath(options = {}, repo, file) {
  const hubCacheDir = resolveHubCacheDir(options);
  if (!hubCacheDir || !repo || !file) {
    return null;
  }
  return path.join(hubCacheDir, "mgt", managedHfFileName(repo, file));
}

/**
 * Resolve the layout used through v0.10.1 so an update can migrate existing
 * multi-gigabyte downloads without downloading or copying them again.
 *
 * @param {RuntimeOptions} [options]
 * @param {string | null | undefined} [repo]
 * @param {string | null | undefined} [file]
 * @returns {string | null}
 */
function resolveLegacyManagedHfFilePath(options = {}, repo, file) {
  const hubCacheDir = resolveHubCacheDir(options);
  if (!hubCacheDir || !repo || !file) {
    return null;
  }
  return path.join(
    repoCacheDir(repo, hubCacheDir),
    "snapshots",
    "mgt-managed",
    safeHfRelativePath(file),
  );
}

module.exports = {
  defaultHfHomeDir,
  repoCacheDir,
  resolveHfHomeDir,
  resolveHubCacheDir,
  resolveLegacyManagedHfFilePath,
  resolveLlamaCppCacheDir,
  resolveManagedHfFilePath,
  resolveWorkingDir,
  safeHfRelativePath,
};
