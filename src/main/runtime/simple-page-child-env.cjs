// @ts-check
/** @typedef {import("./runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {import("./runtime-jsdoc-types").ChildEnvBuildOptions} ChildEnvBuildOptions */
/** @typedef {import("./runtime-jsdoc-types").ChildEnvironment} ChildEnvironment */
const path = require("node:path");

const BASE_CHILD_ENV_KEYS = [
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "HOME",
  "LANG",
  "LC_ALL",
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
  "CURL_CA_BUNDLE",
];

const HF_CHILD_ENV_KEYS = ["HF_ENDPOINT", "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"];

const ROCM_CHILD_ENV_KEYS = [
  "ROCM_PATH",
  "HIP_PATH",
  "HIP_VISIBLE_DEVICES",
  "ROCR_VISIBLE_DEVICES",
  "GPU_DEVICE_ORDINAL",
  "HSA_OVERRIDE_GFX_VERSION",
  "HSA_ENABLE_SDMA",
  "PYTORCH_ALLOC_CONF",
  "PYTORCH_HIP_ALLOC_CONF",
  "LD_LIBRARY_PATH",
  "LIBRARY_PATH",
];

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isTruthy(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(text);
}

/**
 * @param {RuntimeOptions} [options]
 * @returns {boolean}
 */
function shouldAllowExternalRuntimeOverrides(options = {}) {
  if (!isLikelyPackagedToolsDir(options.toolsDir)) {
    return true;
  }
  return isTruthy(
    process.env.MGT_ALLOW_EXTERNAL_RUNTIME ??
      process.env.MANGA_TRANSLATOR_ALLOW_EXTERNAL_RUNTIME,
  );
}

/**
 * @param {string} name
 * @param {RuntimeOptions} [options]
 * @returns {string | undefined}
 */
function runtimeOverrideEnv(name, options = {}) {
  return shouldAllowExternalRuntimeOverrides(options)
    ? process.env[name]
    : undefined;
}

/**
 * @param {ChildEnvBuildOptions} [options]
 * @returns {ChildEnvironment}
 */
function buildWhitelistedChildEnv({
  pathDirs = [],
  includeProcessPath = false,
  extraKeys = [],
} = {}) {
  /** @type {ChildEnvironment} */
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

/**
 * @param {RuntimeOptions} [options]
 * @param {Array<string | null | undefined>} [pathDirs]
 * @returns {ChildEnvironment}
 */
function buildUtilityChildEnv(options = {}, pathDirs = []) {
  return buildWhitelistedChildEnv({
    pathDirs,
    includeProcessPath: shouldAllowExternalRuntimeOverrides(options),
    extraKeys: NETWORK_CHILD_ENV_KEYS,
  });
}

/**
 * @param {Array<string | null | undefined>} [pathDirs]
 * @param {boolean} [includeProcessPath]
 * @returns {string}
 */
function buildChildPathEnv(pathDirs = [], includeProcessPath = false) {
  /** @type {string[]} */
  const dirs = [];
  /**
   * @param {string | null | undefined} dir
   * @returns {void}
   */
  const addDir = (dir) => {
    const text = String(dir ?? "").trim();
    if (!text) {
      return;
    }
    const normalized = process.platform === "win32" ? text.toLowerCase() : text;
    if (
      !dirs.some(
        (candidate) =>
          (process.platform === "win32"
            ? candidate.toLowerCase()
            : candidate) === normalized,
      )
    ) {
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
    addDir(
      systemRoot
        ? path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0")
        : null,
    );
  }
  if (includeProcessPath) {
    for (const dir of String(process.env.PATH ?? "").split(path.delimiter)) {
      addDir(dir);
    }
  }
  return dirs.join(path.delimiter);
}

/**
 * @param {string | null | undefined} toolsDir
 * @returns {boolean}
 */
function isLikelyPackagedToolsDir(toolsDir) {
  const text = String(toolsDir ?? "").trim();
  if (!text) {
    return false;
  }
  const normalized = path.resolve(text).replace(/\\/g, "/").toLowerCase();
  return (
    normalized.endsWith("/resources/tools") ||
    normalized.includes("/resources/tools/")
  );
}

module.exports = {
  HF_CHILD_ENV_KEYS,
  NETWORK_CHILD_ENV_KEYS,
  ROCM_CHILD_ENV_KEYS,
  buildChildPathEnv,
  buildUtilityChildEnv,
  buildWhitelistedChildEnv,
  isLikelyPackagedToolsDir,
  runtimeOverrideEnv,
  shouldAllowExternalRuntimeOverrides,
};
