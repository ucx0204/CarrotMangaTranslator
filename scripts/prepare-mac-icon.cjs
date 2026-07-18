#!/usr/bin/env node
// @ts-check

const { existsSync, mkdirSync, rmSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

const root = join(__dirname, "..");
const source = join(root, "docs", "images", "00-carrot-logo.png");
const iconset = join(root, ".tmp", "mac-icon.iconset");
const output = join(root, "build", "icon.icns");

/** @param {string} command @param {string[]} args */
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with exit code ${result.status ?? "null"}`,
    );
  }
}

function main() {
  if (process.platform !== "darwin") {
    throw new Error(
      "The .icns asset must be generated on macOS with sips/iconutil.",
    );
  }
  if (!existsSync(source)) {
    throw new Error(`Missing macOS icon source: ${source}`);
  }

  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  mkdirSync(join(root, "build"), { recursive: true });

  for (const [name, pixels] of [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024],
  ]) {
    run("sips", [
      "-z",
      String(pixels),
      String(pixels),
      source,
      "--out",
      join(iconset, String(name)),
    ]);
  }

  run("iconutil", ["-c", "icns", iconset, "-o", output]);
  rmSync(iconset, { recursive: true, force: true });
  console.log(`[mac-icon] prepared ${output}`);
}

main();
