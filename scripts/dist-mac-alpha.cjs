#!/usr/bin/env node
// @ts-check

const { spawnSync } = require("node:child_process");
const { existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const SIGNING_SECRET_ENV_KEYS = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_API_KEY_P8_B64",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "MAC_CSC_LINK",
  "MAC_CSC_KEY_PASSWORD",
];

/**
 * @param {string[]} [args]
 * @returns {"stable" | "mac-alpha"}
 */
function resolveMacBuildChannel(args = process.argv.slice(2)) {
  const unexpected = args.filter((arg) => arg !== "--stable");
  if (unexpected.length > 0 || args.length > 1) {
    throw new Error(
      `Unsupported macOS packaging arguments: ${args.join(" ") || "none"}`,
    );
  }
  return args.includes("--stable") ? "stable" : "mac-alpha";
}

/**
 * @param {"stable" | "mac-alpha"} channel
 * @param {NodeJS.ProcessEnv} [environment]
 */
function configureMacBuildChannel(channel, environment = process.env) {
  environment.MGT_RELEASE_CHANNEL = channel;
  environment.MANGA_TRANSLATOR_BUILD_CHANNEL = channel;
}

/** @param {string} command @param {string[]} args @param {NodeJS.ProcessEnv} [extraEnv] */
function run(command, args, extraEnv = {}, includeSigningSecrets = true) {
  const environment = { ...process.env, ...extraEnv };
  if (!includeSigningSecrets) stripSigningSecrets(environment);
  const result = spawnSync(command, args, {
    cwd: root,
    env: environment,
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

/** @param {NodeJS.ProcessEnv} environment */
function stripSigningSecrets(environment) {
  for (const key of SIGNING_SECRET_ENV_KEYS) delete environment[key];
  return environment;
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

/**
 * electron-builder treats a present-but-empty CSC_LINK as a path relative to
 * the project directory. GitHub Actions renders an unset secret as an empty
 * environment variable, so remove certificate variables entirely for ad-hoc
 * builds before electron-builder loads its signing configuration.
 *
 * @param {NodeJS.ProcessEnv} [environment]
 */
function configureElectronBuilderSigningEnvironment(environment = process.env) {
  const developerId = environment.MGT_MAC_SIGNING_MODE === "developer-id";
  environment.CSC_IDENTITY_AUTO_DISCOVERY = developerId ? "true" : "false";
  if (!developerId) {
    delete environment.CSC_LINK;
    delete environment.CSC_KEY_PASSWORD;
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

/** @param {NodeJS.ProcessEnv} buildEnv */
function prepareMacBuildInputs(buildEnv) {
  if (process.env.MGT_MAC_BUILD_INPUTS_PREPARED === "1") {
    assertPreparedMacBuildInputs();
    return;
  }
  run(process.execPath, ["scripts/prepare-mac-icon.cjs"], buildEnv, false);
  run("npm", ["run", "build:mac:runners"], buildEnv, false);
  run("npm", ["run", "prepare:mac:runtime"], buildEnv, false);
  run("npm", ["run", "build"], buildEnv, false);
  assertPreparedMacBuildInputs();
}

function assertPreparedMacBuildInputs() {
  const required = [
    join(root, "build", "icon.icns"),
    join(root, "out", "main", "bootstrap.js"),
    join(root, "out", "preload", "index.js"),
    join(root, "out", "renderer", "index.html"),
    join(root, ".tmp", "mac-runtime", "tools", "mac-runtime-manifest.cjs"),
    join(root, ".tmp", "mac-runtime", "tools", "python", "bin", "python3"),
  ];
  const missing = required.filter((filePath) => !existsSync(filePath));
  if (missing.length > 0) {
    throw new Error(
      `Prebuilt macOS packaging inputs are missing: ${missing.join(", ")}`,
    );
  }
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Apple Silicon packages must be built on macOS arm64.");
  }
  const buildChannel = resolveMacBuildChannel();
  configureMacBuildChannel(buildChannel);
  assertSigningConfiguration();
  configureElectronBuilderSigningEnvironment();
  const buildEnv = {
    MGT_RELEASE_CHANNEL: buildChannel,
    MANGA_TRANSLATOR_BUILD_CHANNEL: buildChannel,
    MGT_TARGET_PLATFORM: "darwin",
    MGT_MAC_RUNTIME_ROOT: join(root, ".tmp", "mac-runtime"),
    CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY,
  };

  prepareMacBuildInputs(buildEnv);

  try {
    const { Arch, Platform, build } = require("electron-builder");
    const artifactPaths = await build({
      targets: Platform.MAC.createTarget(["dmg", "zip"], Arch.arm64),
      config: "electron-builder.config.cjs",
      publish: "never",
    });
    assertMacReleaseArtifacts(artifactPaths);
    notarizeAndStapleDiskImage();
  } finally {
    stripSigningSecrets(process.env);
  }
  run(process.execPath, ["scripts/verify-mac-package.cjs"], buildEnv, false);
}

/**
 * @param {() => Promise<void>} [build]
 * @param {{ reportError: (error: unknown) => void; exit: (code: number) => void }} [runtime]
 */
async function runMacBuildCli(
  build = main,
  runtime = {
    reportError: (error) => console.error(error),
    exit: (code) => process.exit(code),
  },
) {
  try {
    await build();
  } catch (error) {
    runtime.reportError(error);
    runtime.exit(1);
  }
}

if (require.main === module) {
  void runMacBuildCli();
}

module.exports = {
  configureElectronBuilderSigningEnvironment,
  configureMacBuildChannel,
  prepareMacBuildInputs,
  resolveMacBuildChannel,
  runMacBuildCli,
  stripSigningSecrets,
};
