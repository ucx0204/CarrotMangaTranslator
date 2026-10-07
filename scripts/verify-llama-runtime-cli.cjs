#!/usr/bin/env node
// Exercise the published native parsers with production presets, without loading
// models or requiring a GPU. Run after compile:electron/build/check.
const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join, resolve, basename } = require("node:path");
const { createRuntimeCliProbe } = require("./llama-runtime-cli-probe.cjs");
const runRuntimeCliProbe = createRuntimeCliProbe();
const {
  getDefaultGemmaPresetForVramMode,
  getLegacyGemmaPresetForVramMode,
} = require(resolve(__dirname, "../out/main/settings/gemmaModelPresets.js"));
const {
  GEMMA_RUNTIME_PRESETS,
  resolveModelSpecificGemmaRuntimePreset,
} = require(resolve(__dirname, "../out/main/settings/gemmaRuntimePresets.js"));
const {
  buildLaunchArgs,
} = require("../src/main/runtime/model/launch-arguments.cjs");
const {
  buildLlamaServerEnv,
} = require("../src/main/runtime/model/server-environment.cjs");
const {
  resolvePreferredLlamaRuntime,
} = require("../src/main/runtime/model/runtime-profile.cjs");
const {
  hasRequiredLlamaRuntimeFiles,
} = require("../src/main/runtime/model/runtime-files.cjs");
const {
  ensureDefaultLlamaRuntimeDownloaded,
} = require("../src/main/runtime/model/llama-runtime-download.cjs");

const workRoot = resolve(__dirname, "../.tmp/llama-runtime-cli");
const argv = process.argv.slice(2);
assert(
  argv.length === 0 || (argv.length === 2 && argv[0] === "--runtime-root"),
  "Expected optional --runtime-root PATH",
);
const suppliedRoot = argv.length ? resolve(argv[1]) : null;
const profiles =
  process.platform === "darwin" && process.arch === "arm64"
    ? [{ llamaRuntimeProfile: "metal" }]
    : process.platform === "win32"
      ? [
          ...["cuda12", "rtx50", "vulkan"].map((llamaRuntimeProfile) => ({
            llamaRuntimeProfile,
          })),
          ...[
            "gfx103X",
            "gfx110X",
            "gfx1150",
            "gfx1151",
            "gfx120X",
            "gfx908",
            "gfx90a",
          ].map((amdRocmTarget) => ({
            llamaRuntimeProfile: "rocm",
            amdRocmTarget,
          })),
        ]
      : [];
assert(
  profiles.length,
  "This gate supports Windows x64 and Apple Silicon macOS",
);
const prepared = new Map();
/** @type {Record<string, unknown>[]} */
const report = [];
let probeSequence = 0;

/** @param {string} serverPath @param {string[]} args @param {Record<string, any>} options */
function runParser(serverPath, args, options) {
  const logPath = join(
    workRoot,
    `probe-${++probeSequence}-${basename(serverPath)}.log`,
  );
  console.log(`Probe ${probeSequence}: ${serverPath} ${args.join(" ")}`);
  return runRuntimeCliProbe(serverPath, args, {
    env: buildLlamaServerEnv(serverPath, options),
    logPath,
  });
}

/** @param {Record<string, any>} options */
async function prepareRuntime(options) {
  const runtime = resolvePreferredLlamaRuntime(options);
  if (prepared.has(runtime.id)) return prepared.get(runtime.id);
  if (!suppliedRoot) await ensureDefaultLlamaRuntimeDownloaded(options);
  const runtimeDir = join(suppliedRoot || options.managedToolsDir, runtime.dir);
  assert(
    hasRequiredLlamaRuntimeFiles(runtimeDir, runtime),
    `Incomplete runtime: ${runtime.id}`,
  );
  const serverPath = join(
    runtimeDir,
    process.platform === "win32" ? "llama-server.exe" : "llama-server",
  );
  const help = runParser(serverPath, ["--help"], options);
  writeFileSync(join(workRoot, `${runtime.id}-help.log`), help.output);
  assert.equal(help.status, 0, `${runtime.id}: ${help.output}`);
  // Prove --help does not bypass argument validation in this exact binary.
  assert.notEqual(
    runParser(serverPath, ["--mgt-invalid-cli-canary", "--help"], options)
      .status,
    0,
  );
  const result = { runtime, serverPath, help: help.output };
  prepared.set(runtime.id, result);
  return result;
}

/** @param {{ llamaRuntimeProfile: string; amdRocmTarget?: string }} profile @param {string} mode @param {(mode: string) => Record<string, any>} modelPreset @param {string} family */
async function verifyPreset(profile, mode, modelPreset, family) {
  const gemma = { ...modelPreset(mode), modelSource: "huggingface" };
  const preset = resolveModelSpecificGemmaRuntimePreset(
    GEMMA_RUNTIME_PRESETS[mode],
    gemma,
    profile.llamaRuntimeProfile,
  );
  const options = {
    ...gemma,
    ...preset,
    ...profile,
    workingDir: workRoot,
    toolsDir: join(workRoot, "bundled"),
    managedToolsDir: join(workRoot, "tools"),
    hfHubCacheDir: join(workRoot, "empty-hf-cache"),
    llamaCacheDir: join(workRoot, "llama-cache"),
    port: 18180,
    imageMinTokens: 1024,
    imageMaxTokens: 1024,
  };
  const { runtime, serverPath, help } = await prepareRuntime(options);
  for (const disableMmap of [false, true]) {
    const args = buildLaunchArgs({ ...options, serverPath, disableMmap });
    const flags = args.filter((arg) => /^--?[a-z]/i.test(arg));
    const supported = new Set(help.match(/--?[a-z][a-z0-9-]*/gi));
    for (const flag of flags)
      assert(supported.has(flag), `${runtime.id} ${mode}: unsupported ${flag}`);
    const parsed = runParser(serverPath, [...args, "--help"], options);
    assert.equal(parsed.status, 0, `${runtime.id} ${mode}: ${parsed.output}`);
    report.push({
      runtime: runtime.id,
      profile,
      mode,
      family,
      disableMmap,
      args,
      parsed: true,
    });
  }
  console.log(`PASS ${runtime.id} ${family}/${mode} (both memory modes)`);
  writeFileSync(
    join(workRoot, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

async function main() {
  mkdirSync(workRoot, { recursive: true });
  mkdirSync(join(workRoot, "bundled"), { recursive: true });
  for (const profile of profiles) {
    for (const mode of Object.keys(GEMMA_RUNTIME_PRESETS)) {
      await verifyPreset(
        profile,
        mode,
        getDefaultGemmaPresetForVramMode,
        "qat",
      );
      await verifyPreset(
        profile,
        mode,
        getLegacyGemmaPresetForVramMode,
        "legacy",
      );
    }
  }
  console.log(
    `Verified ${report.length} production CLI configurations across ${prepared.size} published runtimes. GPU inference is a separate gate.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
