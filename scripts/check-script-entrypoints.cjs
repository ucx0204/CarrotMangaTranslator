#!/usr/bin/env node
const { resolve } = require("node:path");
const {
  buildScriptEntrypointInventory,
} = require("./script-entrypoint-inventory.cjs");

const repoRoot = resolve(__dirname, "..");
const inventory = buildScriptEntrypointInventory(repoRoot);
if (inventory.orphans.length > 0) {
  console.error(
    [
      "Root scripts must be reachable from package scripts/workflows or declared in scripts/manual-entrypoints.json:",
      ...inventory.orphans.map((path) => `- ${path}`),
    ].join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log(
    `Script entrypoint inventory passed (${inventory.entries.length} reachable, ${inventory.manualEntries.length} manual).`,
  );
}
