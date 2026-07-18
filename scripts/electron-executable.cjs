// @ts-check
const { join } = require("node:path");

/**
 * @param {string} root
 * @param {NodeJS.Platform} [platform]
 */
function resolveElectronExecutable(root, platform = process.platform) {
  const distRoot = join(root, "node_modules", "electron", "dist");
  if (platform === "win32") return join(distRoot, "electron.exe");
  if (platform === "darwin") {
    return join(distRoot, "Electron.app", "Contents", "MacOS", "Electron");
  }
  return join(distRoot, "electron");
}

module.exports = { resolveElectronExecutable };
