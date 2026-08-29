#!/usr/bin/env node
// @ts-check

const { createHash } = require("node:crypto");
const {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const root = join(__dirname, "..");
const compiledRoot = join(root, "out", "main", "inpainting", "fluxAssets");
const cpuRunnerModule = join(compiledRoot, "cpuRunner.js");
const constantsModule = join(compiledRoot, "constants.js");
const runtimeModuleLoaderPath = join(
  root,
  "out",
  "main",
  "runtimeModuleLoader.js",
);
const appRuntimeDir = join(root, "out", "app-runtime");
const keep = process.argv.includes("--keep");

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The Flux CPU remote smoke requires Windows x64.");
}
if (!existsSync(cpuRunnerModule) || !existsSync(constantsModule)) {
  throw new Error(
    "Compiled Electron modules are missing. Run npm run build first.",
  );
}

const runtimeDir = mkdtempSync(join(tmpdir(), "mgt-flux-cpu-remote-smoke-"));
const emptyToolsDir = join(runtimeDir, "empty-tools");
mkdirSync(emptyToolsDir);
process.env.MGT_FLUX_KLEIN_TOOLS_DIR = emptyToolsDir;
for (const name of [
  "MGT_FLUX_KLEIN_CPU_EXE",
  "MGT_FLUX_DISABLE_REMOTE_CPU_RUNNER_DOWNLOAD",
  "MGT_FLUX_KLEIN_CPU_RUNNER_BASE_URL",
  "MGT_FLUX_KLEIN_CPU_RUNNER_BYTES",
  "MGT_FLUX_KLEIN_CPU_RUNNER_SHA256",
  "MGT_FLUX_KLEIN_CPU_EXE_BYTES",
  "MGT_FLUX_KLEIN_CPU_EXE_SHA256",
]) {
  delete process.env[name];
}

void main();

async function main() {
  try {
    const runtimeModuleLoader = require(runtimeModuleLoaderPath);
    /** @param {string} moduleId */
    runtimeModuleLoader.loadAppRuntimeModule = (moduleId) =>
      runtimeModuleLoader.loadRuntimeModuleFromDirectory(
        appRuntimeDir,
        moduleId,
      );
    const { ensureManagedFluxCpuRunner } = require(cpuRunnerModule);
    const constants = require(constantsModule);
    const executable = await ensureManagedFluxCpuRunner({
      runtimeDir,
      /** @param {{ progressText: string; detail?: string }} progress */
      onProgress(progress) {
        console.log(
          `[flux-cpu-remote] ${progress.progressText}${progress.detail ? `: ${progress.detail}` : ""}`,
        );
      },
    });
    if (
      statSync(executable).size !== constants.FLUX_CPU_RUNNER_EXECUTABLE_BYTES
    ) {
      throw new Error("Downloaded Flux CPU executable byte size drifted.");
    }
    if (
      (await sha256File(executable)) !==
      constants.FLUX_CPU_RUNNER_EXECUTABLE_SHA256
    ) {
      throw new Error("Downloaded Flux CPU executable SHA-256 drifted.");
    }
    const capabilities = runJsonProbe(executable, ["--capabilities"]);
    const protocol = runJsonProbe(
      executable,
      ["--protocol-smoke"],
      '{"type":"shutdown"}\n',
    );
    if (
      capabilities?.backend !== "cpu-native" ||
      capabilities?.cpu_only !== true ||
      capabilities?.cuda_compiled !== false ||
      capabilities?.metal_compiled !== false ||
      protocol?.backend !== "cpu-native" ||
      protocol?.request !== "shutdown" ||
      protocol?.ok !== true
    ) {
      throw new Error(
        `Unexpected Flux CPU probes: ${JSON.stringify({ capabilities, protocol })}`,
      );
    }
    const cachedExecutable = await ensureManagedFluxCpuRunner({ runtimeDir });
    if (cachedExecutable !== executable) {
      throw new Error(
        "Flux CPU runner cache path changed between resolutions.",
      );
    }
    console.log(
      `[flux-cpu-remote] verified ${constants.FLUX_CPU_RUNNER_RELEASE_TAG} (${statSync(executable).size} bytes, ${constants.FLUX_CPU_RUNNER_EXECUTABLE_SHA256})`,
    );
    if (keep) {
      console.log(`[flux-cpu-remote] kept runtime: ${runtimeDir}`);
    }
  } finally {
    if (!keep) {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  }
}

/** @param {string} path */
async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** @param {string} path @param {string[]} args @param {string} [input] */
function runJsonProbe(path, args, input) {
  const result = spawnSync(path, args, {
    cwd: root,
    encoding: "utf8",
    input,
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${path} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  const line = String(result.stdout || "")
    .split(/\r?\n/u)
    .find((candidate) => candidate.trim().startsWith("{"));
  if (!line) throw new Error(`${path} returned no JSON probe output.`);
  return JSON.parse(line);
}
