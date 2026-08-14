#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

const root = join(__dirname, "..");
const result = spawnSync(process.execPath, [join(__dirname, "check.cjs")], {
  cwd: root,
  env: { ...process.env, MGT_CHECK_BUILD_CACHE: "1" },
  shell: false,
  stdio: "inherit",
});
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
