const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const electronExe = join(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const benchmarkScript = join(root, "scripts", "benchmark-gemma-economy.cjs");

if (!existsSync(electronExe)) {
  throw new Error(`Electron executable is missing: ${electronExe}`);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const result = spawnSync(electronExe, [benchmarkScript], {
  cwd: root,
  env,
  stdio: "inherit",
  windowsHide: true
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
