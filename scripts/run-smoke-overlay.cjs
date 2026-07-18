const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { resolveElectronExecutable } = require("./electron-executable.cjs");

const root = join(__dirname, "..");
const electronExe = resolveElectronExecutable(root);
const smokeScript = join(root, "scripts", "smoke-overlay.cjs");

if (!existsSync(electronExe)) {
  throw new Error(`Electron executable is missing: ${electronExe}`);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const result = spawnSync(electronExe, [smokeScript], {
  cwd: root,
  env,
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
