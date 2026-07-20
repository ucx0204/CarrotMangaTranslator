#!/usr/bin/env node
// @ts-check

const { readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { spawnSync } = require("node:child_process");

const CANDLE_REVISION = "e7e71e18414db8de91113963beaabb6b4046a0a5";
const BROKEN_OFFSET =
  "src1_l.start_offset() * storage.dtype().size_in_bytes(),";
const FIXED_OFFSET = "layout.start_offset() * storage.dtype().size_in_bytes(),";

/**
 * Apply the non-zero input storage offset fix to the exact Candle source used
 * by Cargo. Git dependencies are immutable inputs, so reject any unexpected
 * source instead of guessing how a newer revision should be patched.
 *
 * @param {string} sourcePath
 * @returns {"applied" | "already-applied"}
 */
function patchCandleMetalSource(sourcePath) {
  const source = readFileSync(sourcePath, "utf8");
  const brokenCount = source.split(BROKEN_OFFSET).length - 1;
  const fixedCount = source.split(FIXED_OFFSET).length - 1;
  if (brokenCount === 0 && fixedCount === 1) {
    return "already-applied";
  }
  if (brokenCount !== 1 || fixedCount !== 0) {
    throw new Error(
      `Unexpected Candle quantized Metal offset implementation in ${sourcePath}`,
    );
  }
  writeFileSync(sourcePath, source.replace(BROKEN_OFFSET, FIXED_OFFSET));
  return "applied";
}

/**
 * @param {{ manifestPath: string; cwd: string }} options
 * @returns {string}
 */
function resolveCandleMetalSource(options) {
  const result = spawnSync(
    "cargo",
    [
      "metadata",
      "--manifest-path",
      options.manifestPath,
      "--locked",
      "--format-version",
      "1",
    ],
    {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
      env: process.env,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "cargo metadata failed");
  }
  const stdout = String(result.stdout || "");
  const jsonStart = stdout.indexOf("{");
  if (jsonStart < 0) {
    throw new Error("cargo metadata did not return JSON");
  }
  /**
   * @type {{ packages: Array<{ name: string, source?: string, manifest_path: string }> }}
   */
  const metadata = JSON.parse(stdout.slice(jsonStart));
  const packageInfo = metadata.packages.find(
    (pkg) =>
      pkg.name === "candle-core" &&
      String(pkg.source || "").includes(CANDLE_REVISION),
  );
  if (!packageInfo?.manifest_path) {
    throw new Error(
      `Could not find candle-core at pinned revision ${CANDLE_REVISION}`,
    );
  }
  return join(
    dirname(packageInfo.manifest_path),
    "src",
    "quantized",
    "metal.rs",
  );
}

/** @param {{ manifestPath: string; cwd: string }} options */
function patchCandleMetalQMatMul(options) {
  const sourcePath = resolveCandleMetalSource(options);
  const status = patchCandleMetalSource(sourcePath);
  console.log(`Candle Metal QMatMul offset patch ${status}: ${sourcePath}`);
}

if (require.main === module) {
  const root = join(__dirname, "..");
  patchCandleMetalQMatMul({
    cwd: root,
    manifestPath: join(root, "tools", "mgt-flux-klein-runner", "Cargo.toml"),
  });
}

module.exports = {
  BROKEN_OFFSET,
  CANDLE_REVISION,
  FIXED_OFFSET,
  patchCandleMetalQMatMul,
  patchCandleMetalSource,
  resolveCandleMetalSource,
};
