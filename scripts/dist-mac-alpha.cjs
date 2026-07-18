#!/usr/bin/env node
// @ts-check

const { spawnSync } = require("node:child_process");
const { readdirSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");

/** @param {string} command @param {string[]} args @param {NodeJS.ProcessEnv} [extraEnv] */
function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with exit code ${result.status ?? "null"}`,
    );
  }
}

function assertSigningConfiguration() {
  if (process.env.MGT_MAC_SIGNING_MODE !== "developer-id") {
    return;
  }
  const required = [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
  ];
  const missing = required.filter(
    (key) => !String(process.env[key] || "").trim(),
  );
  if (missing.length > 0) {
    throw new Error(
      `Developer ID signing was requested but these values are missing: ${missing.join(", ")}`,
    );
  }
}

/** @param {string} directory @param {string} extension @returns {string[]} */
function findArtifacts(directory, extension) {
  const matches = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...findArtifacts(entryPath, extension));
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      matches.push(entryPath);
    }
  }
  return matches;
}

function notarizeAndStapleDiskImage() {
  if (process.env.MGT_MAC_SIGNING_MODE !== "developer-id") {
    return;
  }
  const diskImages = findArtifacts(join(root, "dist"), ".dmg");
  if (diskImages.length !== 1) {
    throw new Error(`Expected one DMG to notarize, found ${diskImages.length}`);
  }
  run("xcrun", [
    "notarytool",
    "submit",
    diskImages[0],
    "--key",
    String(process.env.APPLE_API_KEY),
    "--key-id",
    String(process.env.APPLE_API_KEY_ID),
    "--issuer",
    String(process.env.APPLE_API_ISSUER),
    "--wait",
  ]);
  run("xcrun", ["stapler", "staple", diskImages[0]]);
}

/** @param {string[]} artifactPaths */
function assertMacReleaseArtifacts(artifactPaths) {
  const diskImages = artifactPaths.filter((filePath) =>
    filePath.endsWith(".dmg"),
  );
  const zipArchives = artifactPaths.filter((filePath) =>
    filePath.endsWith(".zip"),
  );
  if (diskImages.length !== 1 || zipArchives.length !== 1) {
    throw new Error(
      `electron-builder returned DMG=${diskImages.length} ZIP=${zipArchives.length}: ${artifactPaths.join(", ") || "no artifacts"}`,
    );
  }
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The Apple Silicon Alpha must be built on macOS arm64.");
  }
  assertSigningConfiguration();
  const buildEnv = {
    MGT_RELEASE_CHANNEL: "mac-alpha",
    MANGA_TRANSLATOR_BUILD_CHANNEL: "mac-alpha",
    MGT_TARGET_PLATFORM: "darwin",
    MGT_MAC_RUNTIME_ROOT: join(root, ".tmp", "mac-runtime"),
    CSC_IDENTITY_AUTO_DISCOVERY:
      process.env.MGT_MAC_SIGNING_MODE === "developer-id" ? "true" : "false",
  };

  run(process.execPath, ["scripts/prepare-mac-icon.cjs"], buildEnv);
  run("npm", ["run", "build:mac:runners"], buildEnv);
  run("npm", ["run", "prepare:mac:runtime"], buildEnv);
  run("npm", ["run", "build"], buildEnv);

  const { Arch, Platform, build } = require("electron-builder");
  const artifactPaths = await build({
    targets: Platform.MAC.createTarget(["dmg", "zip"], Arch.arm64),
    config: "electron-builder.config.cjs",
    publish: "never",
  });
  assertMacReleaseArtifacts(artifactPaths);
  notarizeAndStapleDiskImage();
  run(process.execPath, ["scripts/verify-mac-package.cjs"], buildEnv);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
