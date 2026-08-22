// @ts-check

const path = require("node:path");

/**
 * pip reads machine and user configuration files even when Python itself is
 * embedded and PYTHONNOUSERSITE is enabled.  Managed runtimes must not inherit
 * package indexes or install targets from those files (for example, NVIDIA
 * PyIndex's global extra-index-url).
 *
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @param {NodeJS.ProcessEnv} [managedPipEnv]
 * @returns {NodeJS.ProcessEnv}
 */
function buildIsolatedPipEnvironment(baseEnv = {}, managedPipEnv = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!key.toUpperCase().startsWith("PIP_")) {
      env[key] = value;
    }
  }
  return {
    ...env,
    PIP_CONFIG_FILE: resolvePipNullConfigPath(),
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_NO_INPUT: "1",
    ...managedPipEnv,
  };
}

/** @param {NodeJS.Platform} [platform] @returns {string} */
function resolvePipNullConfigPath(platform = process.platform) {
  // pip compares this value with Python's os.devnull.  On Windows that exact
  // spelling is lowercase "nul"; uppercase "NUL" does not suppress all
  // config variants in current pip releases.
  return platform === "win32" ? "nul" : path.posix.join("/", "dev", "null");
}

module.exports = {
  buildIsolatedPipEnvironment,
  resolvePipNullConfigPath,
};
