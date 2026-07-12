// @ts-check
const path = require("node:path");

const {
  DEFAULT_HF_FILE,
  DEFAULT_MODEL_HF,
} = require("../simple-page-defaults.cjs");
const {
  resolveConfiguredLocalModelPath,
  resolveConfiguredModelFile,
  resolveConfiguredModelRepo,
  resolveConfiguredModelSource,
  resolveConfiguredMmprojFile,
  resolveConfiguredMmprojRepo,
} = require("../simple-page-model-config.cjs");
const { runtimeOverrideEnv } = require("../simple-page-child-env.cjs");
const {
  defaultServerPath,
  isGemma31BModel,
  isMainlineGemmaModel,
} = require("../simple-page-runtime-paths.cjs");

/** @typedef {Record<string, any>} LaunchOptions */

/** @param {LaunchOptions} [options] */
function resolveRuntimeProfile(options = {}) {
  return String(
    options.llamaRuntimeProfile ??
      runtimeOverrideEnv("MANGA_TRANSLATOR_LLAMA_RUNTIME_PROFILE", options) ??
      "",
  )
    .trim()
    .toLowerCase();
}

/** @param {LaunchOptions} [options] */
function resolveSelectedServerPath(options = {}) {
  return String(
    options.serverPath ||
      runtimeOverrideEnv("LLAMA_SERVER_PATH", options) ||
      defaultServerPath(options) ||
      "",
  );
}

/** @param {LaunchOptions} [options] */
function isConfiguredLocalGemma4(options = {}) {
  if (resolveConfiguredModelSource(options) !== "local") {
    return true;
  }
  const localName = path.basename(
    resolveConfiguredLocalModelPath(options) || "",
  );
  return /gemma[-_]?4/i.test(localName);
}

/** @param {LaunchOptions} [options] */
function isDefaultGemma4Model(options = {}) {
  if (resolveConfiguredModelSource(options) === "local") {
    const localName = path.basename(
      resolveConfiguredLocalModelPath(options) || "",
    );
    return localName === DEFAULT_HF_FILE;
  }
  return (
    resolveConfiguredModelRepo(options) === DEFAULT_MODEL_HF ||
    resolveConfiguredModelFile(options) === DEFAULT_HF_FILE
  );
}

/**
 * @param {LaunchOptions} [options]
 * @returns {boolean}
 */
function shouldUseBeellamaGemmaLaunch(options = {}) {
  const profile = resolveRuntimeProfile(options);
  if (["vulkan", "vk", "amd-vulkan"].includes(profile)) {
    return false;
  }
  if (!isConfiguredLocalGemma4(options) || isMainlineGemmaModel(options)) {
    return false;
  }
  const serverPath = resolveSelectedServerPath(options);
  if (/beellama/i.test(serverPath) && looksLikeGemma4Model(options)) {
    return true;
  }
  const usesAlternativeBackend =
    ["rocm", "hip", "amd", "amd-rocm"].includes(profile) ||
    /rocm|hip|vulkan/i.test(serverPath);
  return !usesAlternativeBackend && isDefaultGemma4Model(options);
}

/**
 * @param {LaunchOptions} [options]
 * @returns {boolean}
 */
function looksLikeGemma4Model(options = {}) {
  const parts =
    resolveConfiguredModelSource(options) === "local"
      ? [resolveConfiguredLocalModelPath(options)]
      : [
          resolveConfiguredModelRepo(options),
          resolveConfiguredModelFile(options),
          resolveConfiguredMmprojRepo(options),
          resolveConfiguredMmprojFile(options),
        ];
  return parts.some((part) => /gemma[-_]?4/i.test(String(part || "")));
}

/**
 * @param {string | null | undefined} serverPath
 * @param {LaunchOptions} [options]
 * @returns {boolean}
 */
function isServerRuntimeCompatibleWithModel(serverPath, options = {}) {
  if (!serverPath || !looksLikeGemma4Model(options)) {
    return true;
  }
  if (isMainlineGemmaModel(options)) {
    return !/beellama/i.test(serverPath);
  }
  if (isGemma31BModel(options)) {
    return /beellama/i.test(serverPath);
  }
  return true;
}

module.exports = {
  isServerRuntimeCompatibleWithModel,
  looksLikeGemma4Model,
  shouldUseBeellamaGemmaLaunch,
};
