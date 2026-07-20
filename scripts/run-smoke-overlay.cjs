const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { ensureElectronExecutable } = require("./electron-executable.cjs");

const root = join(__dirname, "..");
const electronExe = ensureElectronExecutable(root);
const smokeScript = join(root, "scripts", "smoke-overlay.cjs");

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
