const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { ensureElectronExecutable } = require("./electron-executable.cjs");

const root = join(__dirname, "..");
const electronExe = ensureElectronExecutable(root);
const smokeScript = join(root, "scripts", "smoke-flux-pattern-chapter.cjs");

/** @type {NodeJS.ProcessEnv} */
const env = {
  ...process.env,
  ELECTRON_ENABLE_LOGGING: "1",
  MGT_KEEP_FLUX_DEBUG: "1",
};
delete env["ELECTRON_RUN_AS_NODE"];

const result = spawnSync(electronExe, [smokeScript, ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env,
});

process.exitCode = result.status ?? 1;
