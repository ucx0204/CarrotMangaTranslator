#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

const root = join(__dirname, "..");
console.log(
  "[check] check:cached-build is now an alias; verified step caches are enabled by default.",
);
const result = spawnSync(process.execPath, [join(__dirname, "check.cjs")], {
  cwd: root,
  env: process.env,
  shell: false,
  stdio: "inherit",
});
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
