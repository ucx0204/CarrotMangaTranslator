const { spawnSync } = require("node:child_process");
const { existsSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");
const {
  OPENAI_OAUTH_LICENSES_FILENAME,
  OPENAI_OAUTH_RUNTIME_FILENAME,
} = require("./bundle-openai-oauth-runtime.cjs");
const {
  WINDOWS_EXECUTABLE_FILENAME,
  assertFastZipPayload,
} = require("./installer-zip-safety.cjs");

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
const appExecutable = join(unpackedDir, WINDOWS_EXECUTABLE_FILENAME);
const packagedNativeImportModule = join(
  resourcesDir,
  "app.asar",
  "out",
  "main",
  "nativeDynamicImport.js",
);
const oauthSmokeScript = join(__dirname, "smoke-openai-oauth-runtime.cjs");
const onnxSmokeScript = join(__dirname, "smoke-packaged-onnx-runtime.cjs");
const onnxRuntimeEntryPath = join(
  resourcesDir,
  "app.asar",
  "node_modules",
  "onnxruntime-web",
  "dist",
  "ort.node.min.js",
);
const onnxWasmModulePath = join(
  resourcesDir,
  "app-runtime",
  "onnxruntime-web",
  "1.27.0",
  "ort-wasm-simd-threaded.mjs",
);
const onnxWasmBinaryFixturePath = join(
  root,
  "node_modules",
  "onnxruntime-web",
  "dist",
  "ort-wasm-simd-threaded.wasm",
);
const allowedElectronLocales = new Set([
  "en-GB.pak",
  "en-US.pak",
  "ja.pak",
  "ko.pak",
  "zh-CN.pak",
  "zh-TW.pak",
]);
// The clean v1.7.0 thin payload is 217 files after development-only runtime
// artifacts are omitted. Keep roughly the same regression headroom as v1.6.5.
const MAX_PACKAGED_FILES = 240;
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
if (!existsSync(onnxWasmModulePath)) {
  throw new Error(
    `Packaged ONNX module glue is missing: ${onnxWasmModulePath}`,
  );
}
if (!existsSync(onnxWasmBinaryFixturePath)) {
  throw new Error(
    `ONNX smoke WASM fixture is missing: ${onnxWasmBinaryFixturePath}`,
  );
}
const zipSafety = assertFastZipPayload(unpackedDir);
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

const oauthResult = spawnSync(
  appExecutable,
  [oauthSmokeScript, oauthRuntimePath, packagedNativeImportModule],
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
assertSmokeSucceeded(oauthResult, "Packaged OAuth runtime");
const onnxResult = spawnSync(
  appExecutable,
  [
    onnxSmokeScript,
    onnxRuntimeEntryPath,
    onnxWasmModulePath,
    onnxWasmBinaryFixturePath,
  ],
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
assertSmokeSucceeded(onnxResult, "Packaged ONNX runtime");

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
console.log(oauthResult.stdout.trim());
console.log(onnxResult.stdout.trim());
console.log(
  `[package] ${packageStats.files} files, ${(
    packageStats.bytes /
    1024 /
    1024
  ).toFixed(1)} MiB unpacked`,
);
console.log(
  `[installer] ${zipSafety.entries} ASCII payload entries, longest relative path ${zipSafety.maxRelativePathLength} chars`,
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

/**
 * @param {import("node:child_process").SpawnSyncReturns<string>} result
 * @param {string} label
 */
function assertSmokeSucceeded(result, label) {
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      [
        `${label} smoke failed with exit code ${result.status}.`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}
