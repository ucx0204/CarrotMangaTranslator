// @ts-check

const { copyFileSync, existsSync, mkdirSync, statSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const root = join(__dirname, "..");
const manifestPath = join(root, "tools", "mgt-flux-klein-runner", "Cargo.toml");
const builtRunnerFileName = "mgt-flux-klein.exe";
const runnerFileName = "mgt-flux-klein-cpu.exe";
const targetDir =
  process.env.MGT_FLUX_KLEIN_CPU_TARGET_DIR ||
  join(tmpdir(), "mgt-flux-klein-cpu-target");
const builtRunnerPath = join(targetDir, "release", builtRunnerFileName);
const outputDir = join(root, "tools", "mgt-flux-klein-cpu");
const outputPath = join(outputDir, runnerFileName);
const forceRebuild = process.env.MGT_FORCE_REBUILD_FLUX_CPU_RUNNER === "1";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(
    "Flux CPU runner packaging currently supports Windows x64 only.",
  );
}
if (!existsSync(manifestPath)) {
  throw new Error(`Missing Flux runner manifest: ${manifestPath}`);
}

if (!forceRebuild && isUsableRunner(outputPath)) {
  assertCpuOnlyCapabilities(outputPath);
  console.log(`Flux CPU-only runner already exists: ${outputPath}`);
  process.exit(0);
}

const cargoArgs = [
  "build",
  "--release",
  "--locked",
  "--no-default-features",
  "--manifest-path",
  manifestPath,
];
console.log(`> cargo ${cargoArgs.join(" ")}`);
const build = spawnSync("cargo", cargoArgs, {
  cwd: root,
  env: {
    ...process.env,
    CARGO_TARGET_DIR: targetDir,
    LLAMA_CPP_TAG: "b-mgt-unused",
    RUSTFLAGS: buildRustFlags(),
  },
  stdio: "inherit",
  shell: false,
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
if (!isUsableRunner(builtRunnerPath)) {
  throw new Error(`Flux CPU runner build did not produce ${builtRunnerPath}`);
}

assertCpuOnlyCapabilities(builtRunnerPath);
mkdirSync(outputDir, { recursive: true });
copyFileSync(builtRunnerPath, outputPath);
assertCpuOnlyCapabilities(outputPath);
console.log(`Prepared Flux CPU-only runner: ${outputPath}`);

/** @param {string} path */
function assertCpuOnlyCapabilities(path) {
  const result = spawnSync(path, ["--capabilities"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Flux CPU runner capability probe failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  const line = String(result.stdout || "")
    .split(/\r?\n/)
    .find((candidate) => candidate.trim().startsWith("{"));
  if (!line) {
    throw new Error("Flux CPU runner capability probe returned no JSON");
  }
  const capabilities = JSON.parse(line);
  if (
    capabilities.backend !== "cpu-native" ||
    capabilities.cpu_only !== true ||
    capabilities.cuda_compiled !== false ||
    capabilities.metal_compiled !== false
  ) {
    throw new Error(
      `Flux runner is not CPU-only: ${JSON.stringify(capabilities)}`,
    );
  }
}

/** @param {string} path */
function isUsableRunner(path) {
  try {
    return (
      existsSync(path) &&
      statSync(path).isFile() &&
      statSync(path).size > 1024 * 1024
    );
  } catch (_error) {
    return false;
  }
}

function buildRustFlags() {
  const flags = [process.env.RUSTFLAGS].filter(Boolean);
  const buildHome = process.env.USERPROFILE || process.env.HOME;
  const remaps = [
    [root, "<mgt-source>"],
    [buildHome, "<build-home>"],
    [process.env.CARGO_HOME, "<cargo-home>"],
    [buildHome ? join(buildHome, ".cargo") : null, "<cargo-home>"],
  ];
  for (const [from, to] of remaps) {
    if (from && existsSync(from)) {
      flags.push(`--remap-path-prefix=${from}=${to}`);
    }
  }
  return flags.join(" ").trim();
}
