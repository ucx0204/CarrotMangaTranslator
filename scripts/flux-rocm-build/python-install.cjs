/**
 * @typedef {{ line(text: string): void; raw(text: string): void; close(): void }} BuildLogger
 * @typedef {{ pythonExe: string; packageDir: string; runtimeDir: string; logger: BuildLogger }} InitializeRocmOptions
 */
const { mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { pythonVersion } = require("./config.cjs");
const { run } = require("./process-utils.cjs");
const { mergePathList } = require("./windows-native-tools.cjs");

/**
 * @param {string} runtimeDir
 * @param {string} packageDir
 * @returns {NodeJS.ProcessEnv}
 */
function buildPythonPackageInstallEnv(runtimeDir, packageDir) {
  const pathEntries = [
    join(runtimeDir, "bootstrap-python", `python-${pythonVersion}`),
    join(runtimeDir, "bootstrap-python", `python-${pythonVersion}`, "Scripts"),
    packageDir,
    join(packageDir, "Scripts"),
  ];
  const tmpDir = join(runtimeDir, "t");
  const pipCacheDir = join(runtimeDir, "pip-cache");
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(pipCacheDir, { recursive: true });
  return {
    ...process.env,
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1",
    PYTHONUNBUFFERED: "1",
    PYTHONPATH: packageDir,
    PIP_CACHE_DIR: pipCacheDir,
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    TMP: tmpDir,
    TEMP: tmpDir,
    PATH: mergePathList(pathEntries, process.env.PATH),
  };
}

/**
 * @param {InitializeRocmOptions} options
 * @returns {Promise<void>}
 */
async function initializeRocmSdk({
  pythonExe,
  packageDir,
  runtimeDir,
  logger,
}) {
  const env = buildPythonPackageInstallEnv(runtimeDir, packageDir);
  logger.line("Initializing ROCm SDK package contents with rocm_sdk.");
  await run(pythonExe, ["-m", "rocm_sdk", "init"], {
    env,
    logger,
    cwd: packageDir,
  });
  await run(pythonExe, ["-m", "rocm_sdk", "path", "--cmake"], {
    env,
    logger,
    cwd: packageDir,
  });
}

module.exports = { buildPythonPackageInstallEnv, initializeRocmSdk };
