// @ts-check
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
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

/**
 * Electron 42+ downloads its binary on first use instead of during npm install.
 * These scripts launch the binary directly, so mirror that first-use bootstrap
 * before returning the executable path.
 *
 * @param {string} root
 * @param {NodeJS.Platform} [platform]
 */
function ensureElectronExecutable(root, platform = process.platform) {
  const executablePath = resolveElectronExecutable(root, platform);
  if (existsSync(executablePath)) {
    return executablePath;
  }

  const installerPath = join(root, "node_modules", "electron", "install.js");
  const result = spawnSync(process.execPath, [installerPath], {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Electron binary installation failed with exit code ${result.status ?? "null"}.`,
    );
  }
  if (!existsSync(executablePath)) {
    throw new Error(`Electron installer did not create: ${executablePath}`);
  }
  return executablePath;
}

module.exports = { ensureElectronExecutable, resolveElectronExecutable };
