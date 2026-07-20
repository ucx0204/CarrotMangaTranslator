// @ts-check
const { statSync } = require("node:fs");
const { join } = require("node:path");

const MAC_INPAINTING_RUNNERS = [
  "mgt-koharu-inpaint-runner",
  "mgt-flux-klein-runner",
];

/** @param {string} root */
function resolveMacInpaintingRunnerPaths(root) {
  return MAC_INPAINTING_RUNNERS.map((directory) => {
    const executable =
      directory === "mgt-flux-klein-runner" ? "mgt-flux-klein" : directory;
    return join(
      root,
      "tools",
      directory,
      "target",
      "aarch64-apple-darwin",
      "release",
      executable,
    );
  });
}

/** @param {string} filePath */
function isUsableExecutable(filePath) {
  try {
    const stat = statSync(filePath);
    return stat.isFile() && stat.size > 0 && (stat.mode & 0o111) !== 0;
  } catch (_error) {
    return false;
  }
}

/**
 * @param {string} root
 * @param {{ platform?: NodeJS.Platform; arch?: string; isUsable?: (filePath: string) => boolean }} [options]
 */
function resolveMissingMacInpaintingRunners(root, options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== "darwin" || arch !== "arm64") return [];
  const isUsable = options.isUsable ?? isUsableExecutable;
  return resolveMacInpaintingRunnerPaths(root).filter(
    (filePath) => !isUsable(filePath),
  );
}

module.exports = {
  resolveMacInpaintingRunnerPaths,
  resolveMissingMacInpaintingRunners,
};
