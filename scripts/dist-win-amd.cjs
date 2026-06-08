#!/usr/bin/env node
const { spawnSync } = require("node:child_process");

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      ...extraEnv
    }
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  if (result.error) {
    throw result.error;
  }
}

run("node", ["scripts/prepare-ocr-python.cjs"]);
run("npm", ["run", "build"]);
run(
  "npx",
  ["electron-builder", "--config", "electron-builder.config.cjs", "--win", "nsis", "--x64"],
  { MGT_ALLOW_MISSING_FLUX_RUNNER: "1" }
);
