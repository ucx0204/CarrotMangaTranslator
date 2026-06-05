const path = require("node:path");

const { runtimeOverrideEnv } = require("./simple-page-child-env.cjs");

function resolveWorkingDir(options = {}) {
  return options.workingDir || process.cwd();
}

function defaultHfHomeDir() {
  const xdgCacheHome = String(process.env.XDG_CACHE_HOME ?? "").trim();
  if (xdgCacheHome) {
    return path.join(xdgCacheHome, "huggingface");
  }

  const homeDir = String(process.env.USERPROFILE ?? process.env.HOME ?? "").trim();
  if (!homeDir) {
    return null;
  }

  return path.join(homeDir, ".cache", "huggingface");
}

function resolveHfHomeDir(options = {}) {
  return (
    options.hfHomeDir ||
    runtimeOverrideEnv("HF_HOME", options) ||
    runtimeOverrideEnv("MANGA_TRANSLATOR_HF_HOME", options) ||
    defaultHfHomeDir()
  );
}

function resolveHubCacheDir(options = {}) {
  const hfHomeDir = resolveHfHomeDir(options);
  return (
    options.hfHubCacheDir ||
    runtimeOverrideEnv("HF_HUB_CACHE", options) ||
    runtimeOverrideEnv("HUGGINGFACE_HUB_CACHE", options) ||
    (hfHomeDir ? path.join(hfHomeDir, "hub") : null)
  );
}

function resolveLlamaCppCacheDir(options = {}) {
  const explicit = String(options.llamaCacheDir ?? runtimeOverrideEnv("MANGA_TRANSLATOR_LLAMA_CACHE_DIR", options) ?? "").trim();
  if (explicit) {
    return explicit;
  }
  if (process.platform === "win32") {
    const localAppData = String(process.env.LOCALAPPDATA ?? "").trim();
    return localAppData ? path.join(localAppData, "manga-gemma-translator", "llama.cpp") : null;
  }
  const xdgCacheHome = String(process.env.XDG_CACHE_HOME ?? "").trim();
  if (xdgCacheHome) {
    return path.join(xdgCacheHome, "manga-gemma-translator", "llama.cpp");
  }
  const homeDir = String(process.env.HOME ?? "").trim();
  return homeDir ? path.join(homeDir, ".cache", "manga-gemma-translator", "llama.cpp") : null;
}

function repoCacheDir(repoId, hubCacheDir) {
  return path.join(hubCacheDir, `models--${repoId.replace(/\//g, "--")}`);
}

function safeHfRelativePath(file) {
  const normalized = String(file ?? "").replace(/\\/g, "/").trim();
  if (!normalized || path.isAbsolute(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid Hugging Face file path: ${file}`);
  }
  return normalized.split("/").join(path.sep);
}

function resolveManagedHfFilePath(options = {}, repo, file) {
  const hubCacheDir = resolveHubCacheDir(options);
  if (!hubCacheDir || !repo || !file) {
    return null;
  }
  return path.join(repoCacheDir(repo, hubCacheDir), "snapshots", "mgt-managed", safeHfRelativePath(file));
}

module.exports = {
  defaultHfHomeDir,
  repoCacheDir,
  resolveHfHomeDir,
  resolveHubCacheDir,
  resolveLlamaCppCacheDir,
  resolveManagedHfFilePath,
  resolveWorkingDir,
  safeHfRelativePath
};
