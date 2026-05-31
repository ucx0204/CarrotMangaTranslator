const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const electronExe = join(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const smokeScript = join(root, "scripts", "smoke-flux-pattern-chapter.cjs");

if (!existsSync(electronExe)) {
  throw new Error(`Electron executable is missing: ${electronExe}`);
}

const env = {
  ...process.env,
  ELECTRON_ENABLE_LOGGING: "1",
  MGT_KEEP_FLUX_DEBUG: "1"
};
delete env.ELECTRON_RUN_AS_NODE;

const result = spawnSync(electronExe, [smokeScript, ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env
});

process.exitCode = result.status ?? 1;
