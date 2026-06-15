#!/usr/bin/env node
const { spawnSync } = require("node:child_process");

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      MGT_THIN_INSTALLER: "1",
      MGT_ALLOW_MISSING_FLUX_RUNNER: "1",
      ...extraEnv,
    },
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("npm", ["run", "build"]);
run("npx", [
  "electron-builder",
  "--config",
  "electron-builder.config.cjs",
  "--win",
  "nsis",
  "--x64",
]);
