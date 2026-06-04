const path = require("node:path");

const BASE_CHILD_ENV_KEYS = [
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "HOME",
  "LANG",
  "LC_ALL"
];

const NETWORK_CHILD_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_FILE",
  "CURL_CA_BUNDLE"
];

const HF_CHILD_ENV_KEYS = [
  "HF_ENDPOINT",
  "HF_TOKEN",
  "HUGGING_FACE_HUB_TOKEN"
];

function isTruthy(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(text);
}

function shouldAllowExternalRuntimeOverrides(options = {}) {
  if (!isLikelyPackagedToolsDir(options.toolsDir)) {
    return true;
  }
  return isTruthy(process.env.MGT_ALLOW_EXTERNAL_RUNTIME ?? process.env.MANGA_TRANSLATOR_ALLOW_EXTERNAL_RUNTIME);
}

function runtimeOverrideEnv(name, options = {}) {
  return shouldAllowExternalRuntimeOverrides(options) ? process.env[name] : undefined;
}

function buildWhitelistedChildEnv({ pathDirs = [], includeProcessPath = false, extraKeys = [] } = {}) {
  const env = {};
  for (const key of [...BASE_CHILD_ENV_KEYS, ...extraKeys]) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }

  const runtimePath = buildChildPathEnv(pathDirs, includeProcessPath);
  if (runtimePath) {
    env.PATH = runtimePath;
  }
  return env;
}

function buildUtilityChildEnv(options = {}, pathDirs = []) {
  return buildWhitelistedChildEnv({
    pathDirs,
    includeProcessPath: shouldAllowExternalRuntimeOverrides(options),
    extraKeys: NETWORK_CHILD_ENV_KEYS
  });
}

function buildChildPathEnv(pathDirs = [], includeProcessPath = false) {
  const dirs = [];
  const addDir = (dir) => {
    const text = String(dir ?? "").trim();
    if (!text) {
      return;
    }
    const normalized = process.platform === "win32" ? text.toLowerCase() : text;
    if (!dirs.some((candidate) => (process.platform === "win32" ? candidate.toLowerCase() : candidate) === normalized)) {
      dirs.push(text);
    }
  };

  for (const dir of pathDirs) {
    addDir(dir);
  }
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR;
    addDir(systemRoot ? path.join(systemRoot, "System32") : null);
    addDir(systemRoot);
    addDir(systemRoot ? path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0") : null);
  }
  if (includeProcessPath) {
    for (const dir of String(process.env.PATH ?? "").split(path.delimiter)) {
      addDir(dir);
    }
  }
  return dirs.join(path.delimiter);
}

function isLikelyPackagedToolsDir(toolsDir) {
  const text = String(toolsDir ?? "").trim();
  if (!text) {
    return false;
  }
  const normalized = path.resolve(text).replace(/\\/g, "/").toLowerCase();
  return normalized.endsWith("/resources/tools") || normalized.includes("/resources/tools/");
}

module.exports = {
  HF_CHILD_ENV_KEYS,
  NETWORK_CHILD_ENV_KEYS,
  buildChildPathEnv,
  buildUtilityChildEnv,
  buildWhitelistedChildEnv,
  isLikelyPackagedToolsDir,
  runtimeOverrideEnv,
  shouldAllowExternalRuntimeOverrides
};
