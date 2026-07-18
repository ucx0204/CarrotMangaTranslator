// @ts-check
const { mkdirSync } = require("node:fs");
const path = require("node:path");
const {
  HF_CHILD_ENV_KEYS,
  NETWORK_CHILD_ENV_KEYS,
  ROCM_CHILD_ENV_KEYS,
  buildWhitelistedChildEnv,
  runtimeOverrideEnv,
  shouldAllowExternalRuntimeOverrides,
} = require("../simple-page-child-env.cjs");
const {
  resolveHfHomeDir,
  resolveHubCacheDir,
  resolveLlamaCppCacheDir,
} = require("../simple-page-cache-paths.cjs");
const {
  resolvePreferredLlamaRuntime,
} = require("../simple-page-runtime-paths.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { port?: unknown }} ServerRuntimeOptions */

/** @param {string} serverPath @param {ServerRuntimeOptions} [options] */
function buildLlamaServerEnv(serverPath, options = {}) {
  const runtime = resolvePreferredLlamaRuntime(options);
  const backend = String(runtime.backend || "cuda").toLowerCase();
  const paths = resolveRocmPaths(options);
  const env = buildBaseServerEnv(serverPath, options, backend, paths);
  applyHuggingFaceEnv(env, options);
  applyLlamaCacheEnv(env, options);
  applyRocmEnv(env, backend, paths);
  applyMetalEnv(env, serverPath, runtime, backend);
  env.MANGA_TRANSLATOR_LLAMA_PORT = String(options.port);
  return env;
}

/** @param {ServerRuntimeOptions} options */
function resolveRocmPaths(options) {
  const rocmPath =
    runtimeOverrideEnv("ROCM_PATH", options) ||
    process.env.ROCM_PATH ||
    (process.platform === "win32" ? "" : "/opt/rocm");
  const hipPath =
    runtimeOverrideEnv("HIP_PATH", options) || process.env.HIP_PATH || rocmPath;
  return { rocmPath, hipPath };
}

/** @param {string} serverPath @param {ServerRuntimeOptions} options @param {string} backend @param {ReturnType<typeof resolveRocmPaths>} paths */
function buildBaseServerEnv(serverPath, options, backend, paths) {
  const rocm = ["rocm", "hip"].includes(backend);
  const pathDirs = [
    path.dirname(serverPath),
    ...(rocm ? rocmBinaryDirs(paths) : []),
  ];
  return buildWhitelistedChildEnv({
    pathDirs,
    includeProcessPath: shouldAllowExternalRuntimeOverrides(options),
    extraKeys: [
      ...NETWORK_CHILD_ENV_KEYS,
      ...HF_CHILD_ENV_KEYS,
      ...(rocm ? ROCM_CHILD_ENV_KEYS : []),
    ],
  });
}

/** @param {ReturnType<typeof resolveRocmPaths>} paths */
function rocmBinaryDirs({ rocmPath, hipPath }) {
  return [
    rocmPath ? path.join(rocmPath, "bin") : null,
    rocmPath ? path.join(rocmPath, "llvm", "bin") : null,
    hipPath ? path.join(hipPath, "bin") : null,
  ];
}

/** @param {NodeJS.ProcessEnv} env @param {ServerRuntimeOptions} options */
function applyHuggingFaceEnv(env, options) {
  const hfHomeDir = resolveHfHomeDir(options);
  const hfHubCacheDir = resolveHubCacheDir(options);
  if (hfHomeDir) env.HF_HOME = hfHomeDir;
  if (hfHubCacheDir) {
    env.HF_HUB_CACHE = hfHubCacheDir;
    env.HUGGINGFACE_HUB_CACHE = hfHubCacheDir;
  }
}

/** @param {NodeJS.ProcessEnv} env @param {ServerRuntimeOptions} options */
function applyLlamaCacheEnv(env, options) {
  const cacheDir = resolveLlamaCppCacheDir(options);
  if (!cacheDir) return;
  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch (_error) {
    // error-policy-allow: llama-server owns its documented cache-directory fallback.
  }
  env.LLAMA_CACHE = cacheDir;
  env.LLAMA_CACHE_DIR = cacheDir;
}

/** @param {NodeJS.ProcessEnv} env @param {string} backend @param {ReturnType<typeof resolveRocmPaths>} paths */
function applyRocmEnv(env, backend, { rocmPath, hipPath }) {
  if (!["rocm", "hip"].includes(backend) || !rocmPath) return;
  env.ROCM_PATH = env.ROCM_PATH || rocmPath;
  env.HIP_PATH = env.HIP_PATH || hipPath || rocmPath;
  if (process.platform === "win32") return;
  env.LD_LIBRARY_PATH = [
    env.LD_LIBRARY_PATH,
    path.join(rocmPath, "lib"),
    path.join(rocmPath, "lib64"),
  ]
    .filter(Boolean)
    .join(":");
}

/** @param {NodeJS.ProcessEnv} env @param {string} serverPath @param {{ dflashRing?: unknown; kind?: unknown }} runtime @param {string} backend */
function applyMetalEnv(env, serverPath, runtime, backend) {
  if (backend !== "metal") return;
  const runtimeDir = path.dirname(serverPath);
  env.GGML_METAL_PATH_RESOURCES = runtimeDir;
  env.DYLD_LIBRARY_PATH = [runtimeDir, env.DYLD_LIBRARY_PATH]
    .filter(Boolean)
    .join(":");
  if (
    runtime.dflashRing === "cpu" ||
    String(runtime.kind || "").toLowerCase() === "beellama-metal"
  ) {
    // BeeLlama 31B Alpha must keep the DFlash ring on CPU/unified memory.
    // Never let an ambient environment silently switch it to the GPU ring.
    env.GGML_DFLASH_GPU_RING = "0";
  }
}

module.exports = { buildLlamaServerEnv };
