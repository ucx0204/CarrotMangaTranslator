const { spawnSync } = require("node:child_process");
const { existsSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");
const {
  OPENAI_OAUTH_LICENSES_FILENAME,
  OPENAI_OAUTH_RUNTIME_FILENAME,
} = require("./bundle-openai-oauth-runtime.cjs");

const root = join(__dirname, "..");
const unpackedDir = join(root, "dist", "win-unpacked");
const resourcesDir = join(unpackedDir, "resources");
const oauthRuntimePath = join(
  resourcesDir,
  "app-runtime",
  OPENAI_OAUTH_RUNTIME_FILENAME,
);
const oauthLicensesPath = join(
  resourcesDir,
  "app-runtime",
  OPENAI_OAUTH_LICENSES_FILENAME,
);
const asarUnpackedNodeModules = join(
  resourcesDir,
  "app.asar.unpacked",
  "node_modules",
);
const appExecutable = join(unpackedDir, "당근망가번역기.exe");
const packagedNativeImportModule = join(
  resourcesDir,
  "app.asar",
  "out",
  "main",
  "nativeDynamicImport.js",
);
const smokeScript = join(__dirname, "smoke-openai-oauth-runtime.cjs");
const allowedElectronLocales = new Set([
  "en-GB.pak",
  "en-US.pak",
  "ja.pak",
  "ko.pak",
  "zh-CN.pak",
  "zh-TW.pak",
]);
const MAX_PACKAGED_FILES = 190;
const MAX_PACKAGED_BYTES = 700 * 1024 * 1024;

if (!existsSync(oauthRuntimePath)) {
  throw new Error(`Packaged OAuth runtime is missing: ${oauthRuntimePath}`);
}
if (!existsSync(oauthLicensesPath)) {
  throw new Error(
    `Packaged OAuth third-party licenses are missing: ${oauthLicensesPath}`,
  );
}
if (existsSync(asarUnpackedNodeModules)) {
  throw new Error(
    `Production node_modules must remain inside app.asar: ${asarUnpackedNodeModules}`,
  );
}
if (!existsSync(appExecutable)) {
  throw new Error(`Packaged Electron executable is missing: ${appExecutable}`);
}
const packagedElectronLocales = new Set(
  readdirSync(join(unpackedDir, "locales")),
);
for (const localeFile of allowedElectronLocales) {
  if (!packagedElectronLocales.has(localeFile)) {
    throw new Error(`Required Electron locale was not packaged: ${localeFile}`);
  }
}
for (const localeFile of packagedElectronLocales) {
  if (!allowedElectronLocales.has(localeFile)) {
    throw new Error(`Unexpected Electron locale was packaged: ${localeFile}`);
  }
}

const result = spawnSync(
  appExecutable,
  [smokeScript, oauthRuntimePath, packagedNativeImportModule],
  {
    encoding: "utf8",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
    timeout: 30_000,
    windowsHide: true,
  },
);
if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  throw new Error(
    [
      `Packaged OAuth runtime smoke failed with exit code ${result.status}.`,
      result.stdout,
      result.stderr,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

const packageStats = countFiles(unpackedDir);
if (packageStats.files > MAX_PACKAGED_FILES) {
  throw new Error(
    `Packaged file-count budget exceeded: ${packageStats.files} > ${MAX_PACKAGED_FILES}`,
  );
}
if (packageStats.bytes > MAX_PACKAGED_BYTES) {
  throw new Error(
    `Packaged size budget exceeded: ${(
      packageStats.bytes /
      1024 /
      1024
    ).toFixed(1)} MiB > ${MAX_PACKAGED_BYTES / 1024 / 1024} MiB`,
  );
}
console.log(result.stdout.trim());
console.log(
  `[package] ${packageStats.files} files, ${(
    packageStats.bytes /
    1024 /
    1024
  ).toFixed(1)} MiB unpacked`,
);

/**
 * @param {string} directory
 * @returns {{ files: number; bytes: number }}
 */
function countFiles(directory) {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      const child = countFiles(entryPath);
      files += child.files;
      bytes += child.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += statSync(entryPath).size;
    }
  }
  return { files, bytes };
}
