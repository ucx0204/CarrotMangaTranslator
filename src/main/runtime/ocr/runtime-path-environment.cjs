// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {import("../runtime-jsdoc-types").OcrRuntimeLayout} OcrRuntimeLayout */

const path = require("node:path");
const { resolveToolsDir } = require("../simple-page-runtime-paths.cjs");
const {
  isHayaiOcrPipeline,
  isOcrTorchRuntime,
  resolveOcrGpuBackend,
  resolveOcrRuntimeVariant,
} = require("./runtime-device.cjs");
const {
  resolveOcrPythonPackageDir,
  resolveOcrRuntimeDir,
  resolveOcrVenvDir,
} = require("./runtime-layout.cjs");

const TORCH_DLL_RELATIVE_DIRS = ["Scripts", "torch", path.join("torch", "lib")];

/** @param {RuntimeOptions} [options] @param {OcrRuntimeLayout | null} [runtime] @param {string} [runtimeDir] @returns {Array<string | null | undefined>} */
function buildOcrRuntimePathDirs(
  options = {},
  runtime = null,
  runtimeDir = resolveOcrRuntimeDir(options),
) {
  const variant = resolveOcrRuntimeVariant(options);
  const venvDir = resolveOcrVenvDir(runtimeDir, variant, options);
  const venvBinDir = resolveOcrVenvBinDir(venvDir);
  const toolsDir = resolveToolsDir(options);
  return [
    runtime?.pythonPath ? path.dirname(runtime.pythonPath) : null,
    venvBinDir,
    ...buildOcrRuntimeDllSearchDirs(options, runtime, runtimeDir),
    path.join(toolsDir || "", "python"),
    path.join(toolsDir || "", "python", "python-embed"),
    runtimeDir,
  ];
}

/** @param {string} venvDir @param {NodeJS.Platform} [platform] @returns {string} */
function resolveOcrVenvBinDir(venvDir, platform = process.platform) {
  return platform === "win32"
    ? path.join(venvDir, "Scripts")
    : path.join(venvDir, "bin");
}

/** @param {RuntimeOptions} [options] @param {OcrRuntimeLayout | null} [runtime] @param {string} [runtimeDir] @returns {string[]} */
function buildOcrRuntimeDllSearchDirs(
  options = {},
  runtime = null,
  runtimeDir = resolveOcrRuntimeDir(options),
) {
  const packageDir =
    runtime?.packageDir || resolveOcrPythonPackageDir(runtimeDir, options);
  const paddleDirs = isHayaiOcrPipeline(options)
    ? []
    : buildPaddleDllSearchDirs(packageDir);
  if (resolveOcrGpuBackend(options) === "rocm-transformers") {
    return [...paddleDirs, ...buildRocmDllSearchDirs(packageDir)];
  }
  return isOcrTorchRuntime(options)
    ? [...paddleDirs, ...buildTorchDllSearchDirs(packageDir)]
    : paddleDirs;
}

/** @param {string} packageDir @returns {string[]} */
function buildPaddleDllSearchDirs(packageDir) {
  return [
    packageDir,
    path.join(packageDir, "paddle"),
    path.join(packageDir, "paddle", "base"),
    path.join(packageDir, "paddle", "base", "libs"),
    path.join(packageDir, "paddle", "libs"),
    path.join(packageDir, "paddle.libs"),
    path.join(packageDir, "Paddle.libs"),
  ];
}

/** @param {string} packageDir @returns {string[]} */
function buildRocmDllSearchDirs(packageDir) {
  return [
    ...TORCH_DLL_RELATIVE_DIRS,
    "rocm",
    path.join("rocm", "bin"),
    path.join("rocm", "lib"),
    "rocm_sdk",
    path.join("rocm_sdk", "bin"),
    "_rocm_sdk_core",
    path.join("_rocm_sdk_core", "bin"),
    path.join("_rocm_sdk_core", "lib", "llvm", "bin"),
    "_rocm_sdk_devel",
    path.join("_rocm_sdk_devel", "bin"),
    path.join("_rocm_sdk_devel", "lib", "llvm", "bin"),
    "_rocm_sdk_libraries_custom",
    path.join("_rocm_sdk_libraries_custom", "bin"),
    path.join("_rocm_sdk_libraries_custom", "bin", "hipblaslt"),
    path.join("_rocm_sdk_libraries_custom", "bin", "hipblaslt", "library"),
  ].map((relativePath) => path.join(packageDir, relativePath));
}

/** @param {string} packageDir @returns {string[]} */
function buildTorchDllSearchDirs(packageDir) {
  return TORCH_DLL_RELATIVE_DIRS.map((relativePath) =>
    path.join(packageDir, relativePath),
  );
}

module.exports = {
  buildOcrRuntimeDllSearchDirs,
  buildOcrRuntimePathDirs,
  resolveOcrVenvBinDir,
};
