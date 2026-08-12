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
const imageSmokeScript = join(__dirname, "smoke-packaged-image-runtime.cjs");
const imageRuntimePath = join(
  resourcesDir,
  "app-runtime",
  "simple-page-translate.cjs",
);
const ffmpegPath = join(resourcesDir, "tools", "ffmpeg", "ffmpeg.exe");
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
const onnxWasmBinaryPath = join(
  resourcesDir,
  "app-runtime",
  "onnxruntime-web",
  "1.27.0",
  "ort-wasm-simd-threaded.wasm",
);
const onnxWasmBinaryFixturePath = join(
  root,
  "node_modules",
  "onnxruntime-web",
  "dist",
  "ort-wasm-simd-threaded.wasm",
);
// Must match ONNXRUNTIME_WEB_WASM_BINARY_BYTES in bubbleLayout/constants.ts.
const expectedOnnxWasmBinaryBytes = 13_479_978;
const allowedElectronLocales = new Set([
  "en-GB.pak",
  "en-US.pak",
  "ja.pak",
  "ko.pak",
  "zh-CN.pak",
  "zh-TW.pak",
]);
// The clean v1.7.0 thin payload was 217 files after development-only runtime
// artifacts were omitted. v1.10.1 intentionally adds runtime integrity
// manifests and hash-complete dependency locks. Font runtime v2 then adds its
// four small trust/ranker files while leaving the three large model assets
// external. Keep the resulting payload ceiling exact so unrelated packaging
// growth still fails closed.
const MAX_PACKAGED_FILES = 258;
// The trained font matching runtime bundle (~467 MiB) is externalized out of
// the installer and downloaded into the data-root cache on first use, so the
// unpacked payload is ~745 MiB (Electron + app.asar + tools, no bundle) and the
// NSIS installer shrinks to ~333 MiB. The budget guards the UNPACKED size: it
// passes the legit ~745 MiB floor with headroom for renderer/runtime growth
// while rejecting the 467 MiB bundle returning (~1212 MiB) or large training
// datasets / QA artifacts sneaking back in.
const MAX_PACKAGED_BYTES = 1000 * 1024 * 1024;

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
if (!existsSync(onnxWasmBinaryPath)) {
  throw new Error(
    `Packaged ONNX WASM binary is missing: ${onnxWasmBinaryPath}. Font matching pixel inference cannot load without it.`,
  );
}
const packagedOnnxWasmBinaryBytes = statSync(onnxWasmBinaryPath).size;
if (packagedOnnxWasmBinaryBytes !== expectedOnnxWasmBinaryBytes) {
  throw new Error(
    `Packaged ONNX WASM binary size mismatch: ${packagedOnnxWasmBinaryBytes} bytes (expected ${expectedOnnxWasmBinaryBytes}).`,
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
const imageResult = spawnSync(
  appExecutable,
  [imageSmokeScript, imageRuntimePath, ffmpegPath],
  {
    encoding: "utf8",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
    timeout: 60_000,
    windowsHide: true,
  },
);
assertSmokeSucceeded(imageResult, "Packaged WebP runtime");

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
console.log(imageResult.stdout.trim());
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
