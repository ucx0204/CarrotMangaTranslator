const {
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
  readFileSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { delimiter, join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { patchCandleMetalQMatMul } = require("./patch-candle-metal-qmatmul.cjs");
const {
  createCudaRootCandidates,
  createFluxCargoInvocation,
  createFluxKleinBuildPlan,
} = require("./flux-klein-build-plan.cjs");

/**
 * @typedef {{ outDir: string; outExe: string }} BuildAlias
 * @typedef {{ computeCap: string | null; cargoTargetDir: string; outDir: string; outExe: string; aliases: BuildAlias[] }} BuildTarget
 * @typedef {{ packages: Array<{ name?: string; manifest_path?: string }> }} CargoMetadata
 */

const root = join(__dirname, "..");
const manifestPath = join(root, "tools", "mgt-flux-klein-runner", "Cargo.toml");
const runnerDirName = "mgt-flux-klein";
const runnerExeName = "mgt-flux-klein.exe";
const cargoTargetDir =
  process.env.MGT_FLUX_KLEIN_TARGET_DIR ||
  join(tmpdir(), "mgt-flux-klein-target");
const cudaRoot = process.env.MGT_FLUX_KLEIN_CUDA_ROOT || findCudaRoot();
const forceRebuild = process.env.MGT_FORCE_REBUILD_FLUX_RUNNER === "1";
/** @type {BuildTarget[]} */
const buildPlan = createFluxKleinBuildPlan({
  root,
  cargoTargetDir,
  computeCaps: process.env.MGT_FLUX_KLEIN_COMPUTE_CAPS,
  singleComputeCap: process.env.CUDA_COMPUTE_CAP,
  runnerDirName,
  runnerExeName,
});

if (
  !forceRebuild &&
  buildPlan.every(
    (entry) =>
      isUsableFile(entry.outExe) &&
      entry.aliases.every((alias) => isUsableFile(alias.outExe)),
  )
) {
  console.log(
    `mgt-flux-klein already exists: ${buildPlan
      .map((entry) => entry.outExe)
      .join(", ")}`,
  );
  process.exit(0);
}

if (!existsSync(manifestPath)) {
  console.error(`Missing Flux runner manifest: ${manifestPath}`);
  process.exit(1);
}

patchCandleMetalQMatMul({ cwd: root, manifestPath });
patchKoharuFluxSources();
for (const entry of buildPlan) {
  runCargo(entry);
  const builtExe = join(entry.cargoTargetDir, "release", runnerExeName);
  if (!isUsableFile(builtExe)) {
    console.error(`Flux runner build did not produce ${builtExe}`);
    process.exit(1);
  }

  mkdirSync(entry.outDir, { recursive: true });
  copyFileSync(builtExe, entry.outExe);
  console.log(
    `Prepared Flux runner${entry.computeCap ? ` sm_${entry.computeCap}` : ""}: ${entry.outExe}`,
  );
  for (const alias of entry.aliases) {
    mkdirSync(alias.outDir, { recursive: true });
    copyFileSync(builtExe, alias.outExe);
    console.log(`Prepared Flux runner alias: ${alias.outExe}`);
  }
}

/**
 * @param {BuildTarget} buildTarget
 */
function runCargo(buildTarget) {
  const msvcBin = process.platform === "win32" ? findMsvcClBin() : null;
  if (buildTarget.computeCap) {
    console.log(`CUDA_COMPUTE_CAP=${buildTarget.computeCap}`);
  }
  const invocation = createFluxCargoInvocation({
    manifestPath,
    buildTarget,
    cudaRoot,
    msvcBin,
    rustFlags: buildRustFlags(),
    basePath: process.env.PATH ?? "",
    pathDelimiter: delimiter,
  });
  run(invocation.command, invocation.args, invocation.env);
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [extraEnv]
 */
function run(command, args, extraEnv = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
  if (result.error) {
    console.error(result.error);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

/** @returns {string | null} */
function findMsvcClBin() {
  const candidates = [
    join(
      "C:",
      "Program Files",
      "Microsoft Visual Studio",
      "2022",
      "Community",
      "VC",
      "Tools",
      "MSVC",
    ),
    join(
      "C:",
      "Program Files",
      "Microsoft Visual Studio",
      "2022",
      "BuildTools",
      "VC",
      "Tools",
      "MSVC",
    ),
    join(
      "C:",
      "Program Files",
      "Microsoft Visual Studio",
      "2022",
      "Professional",
      "VC",
      "Tools",
      "MSVC",
    ),
    join(
      "C:",
      "Program Files",
      "Microsoft Visual Studio",
      "2022",
      "Enterprise",
      "VC",
      "Tools",
      "MSVC",
    ),
  ];
  for (const root of candidates) {
    if (!existsSync(root)) {
      continue;
    }
    const versions = require("node:fs").readdirSync(root).sort().reverse();
    for (const version of versions) {
      const bin = join(root, version, "bin", "Hostx64", "x64");
      if (existsSync(join(bin, "cl.exe"))) {
        return bin;
      }
    }
  }
  return null;
}

/** @returns {string | null} */
function findCudaRoot() {
  const rawCandidates = createCudaRootCandidates(process.env);
  /** @type {string[]} */
  const candidates = [];
  for (const candidate of rawCandidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      candidates.push(candidate);
    }
  }
  return (
    candidates.find((candidate) =>
      existsSync(join(candidate, "bin", "nvcc.exe")),
    ) || null
  );
}

function patchKoharuFluxSources() {
  const metadata = readCargoMetadata();
  const koharuMl = metadata.packages.find((pkg) => pkg.name === "koharu-ml");
  if (!koharuMl?.manifest_path) {
    console.warn(
      "Could not find koharu-ml in cargo metadata; skipping ZLUDA Flux source patch.",
    );
    return;
  }

  const koharuMlDir = koharuMl.manifest_path.replace(/[\\/]Cargo\.toml$/, "");
  const fluxModPath = join(koharuMlDir, "src", "flux2_klein", "mod.rs");
  const sm75DtypePatch = `fn sm75_fp16_enabled() -> bool {
    std::env::var("MGT_FLUX_SM75_FP16")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn flux_model_device() -> Result<Device> {
    #[cfg(feature = "cuda")]
    if sm75_fp16_enabled() {
        let model_device = Device::new_cuda(0)?;
        let (major, minor) = {
            let cuda_device = model_device.as_cuda_device()?;
            cuda_device
                .cuda_stream()
                .context()
                .compute_capability()?
        };
        if (major, minor) != (7, 5) {
            bail!(
                "MGT_FLUX_SM75_FP16 requires CUDA compute capability 7.5, got {major}.{minor}"
            );
        }
        tracing::info!("Flux SM75 mixed-precision CUDA device enabled (transformer=fp32, vae=fp16)");
        return Ok(model_device);
    }

    device(false)
}

fn transformer_dtype(device: &Device) -> DType {
    if device.is_cuda() && !koharu_runtime::zluda_active() {
        return if sm75_fp16_enabled() {
            DType::F32
        } else {
            DType::BF16
        };
    }

    DType::F32
}

fn vae_dtype(device: &Device) -> DType {
    if device.is_cuda() && !koharu_runtime::zluda_active() {
        return if sm75_fp16_enabled() {
            DType::F16
        } else {
            DType::BF16
        };
    }

    DType::F32
}`;
  const legacyFp16DtypePatch = sm75DtypePatch
    .replace(
      'tracing::info!("Flux SM75 mixed-precision CUDA device enabled (transformer=fp32, vae=fp16)");',
      'tracing::info!("Flux SM75 FP16 CUDA device enabled");',
    )
    .replace(
      `fn transformer_dtype(device: &Device) -> DType {
    if device.is_cuda() && !koharu_runtime::zluda_active() {
        return if sm75_fp16_enabled() {
            DType::F32
        } else {
            DType::BF16
        };
    }

    DType::F32
}`,
      `fn transformer_dtype(device: &Device) -> DType {
    if device.is_cuda() && !koharu_runtime::zluda_active() {
        return if sm75_fp16_enabled() {
            DType::F16
        } else {
            DType::BF16
        };
    }

    DType::F32
}`,
    );
  const testableSm75DtypePatch = sm75DtypePatch
    .replace(
      "if (major, minor) != (7, 5) {",
      "if major < 7 || (major == 7 && minor < 5) {",
    )
    .replace(
      "requires CUDA compute capability 7.5, got",
      "requires CUDA compute capability 7.5 or newer, got",
    )
    .replace(
      'tracing::info!("Flux SM75 mixed-precision CUDA device enabled (transformer=fp32, vae=fp16)");',
      'tracing::info!("Flux SM75-compatible mixed-precision CUDA device enabled on {major}.{minor} (transformer=fp32, vae=fp16)");',
    );
  const testableLegacyFp16DtypePatch = legacyFp16DtypePatch
    .replace(
      "if (major, minor) != (7, 5) {",
      "if major < 7 || (major == 7 && minor < 5) {",
    )
    .replace(
      "requires CUDA compute capability 7.5, got",
      "requires CUDA compute capability 7.5 or newer, got",
    )
    .replace(
      'tracing::info!("Flux SM75 FP16 CUDA device enabled");',
      'tracing::info!("Flux SM75-compatible FP16 CUDA device enabled on {major}.{minor}");',
    );
  patchFileVariant(
    fluxModPath,
    [
      testableSm75DtypePatch,
      legacyFp16DtypePatch,
      testableLegacyFp16DtypePatch,
      `fn transformer_dtype(device: &Device) -> DType {\n    if device.is_cuda() {\n        return DType::BF16;\n    }\n\n    DType::F32\n}\n\nfn vae_dtype(device: &Device) -> DType {\n    if device.is_cuda() {\n        return DType::BF16;\n    }\n\n    DType::F32\n}`,
      `fn transformer_dtype(device: &Device) -> DType {\n    if device.is_cuda() && !koharu_runtime::zluda_active() {\n        return DType::BF16;\n    }\n\n    DType::F32\n}\n\nfn vae_dtype(device: &Device) -> DType {\n    if device.is_cuda() && !koharu_runtime::zluda_active() {\n        return DType::BF16;\n    }\n\n    DType::F32\n}`,
    ],
    sm75DtypePatch,
    "SM75 mixed-precision Flux device and dtype",
  );
  patchFile(
    fluxModPath,
    [
      [
        `        let model_device = device(false)?;`,
        `        let model_device = flux_model_device()?;`,
      ],
    ],
    "SM75 FP16 Flux device selection",
  );
  patchFileVariant(
    join(koharuMlDir, "src", "flux2_klein", "transformer.rs"),
    [
      `    #[cfg(feature = "cuda")]\n    if q.device().is_cuda() {\n`,
      `    #[cfg(feature = "cuda")]\n    if q.device().is_cuda() && !koharu_runtime::zluda_active() {\n`,
    ],
    `    #[cfg(feature = "cuda")]\n    if q.device().is_cuda()\n        && !koharu_runtime::zluda_active()\n        && !super::sm75_fp16_enabled()\n    {\n`,
    "SM75 compatible Flux attention",
  );
}

/**
 * @param {string} path
 * @param {string[]} variants
 * @param {string} replacement
 * @param {string} label
 */
function patchFileVariant(path, variants, replacement, label) {
  let text = readFileSync(path, "utf8");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const replacementText = replacement.replace(/\n/g, newline);
  if (text.includes(replacementText)) {
    console.log(`${label} patch already applied: ${path}`);
    return;
  }
  const source = variants
    .map((variant) => variant.replace(/\n/g, newline))
    .find((variant) => text.includes(variant));
  if (!source) {
    throw new Error(`Could not apply ${label} patch to ${path}`);
  }
  text = text.replace(source, replacementText);
  writeFileSync(path, text);
  console.log(`Applied ${label} patch: ${path}`);
}

/** @returns {CargoMetadata} */
function readCargoMetadata() {
  const result = spawnSync(
    "cargo",
    [
      "metadata",
      "--manifest-path",
      manifestPath,
      "--locked",
      "--format-version",
      "1",
    ],
    {
      cwd: root,
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
    process.stderr.write(result.stderr || result.stdout || "");
    process.exit(result.status ?? 1);
  }
  const stdout = String(result.stdout || "");
  const jsonStart = stdout.indexOf("{");
  if (jsonStart < 0) {
    throw new Error("cargo metadata did not return JSON");
  }
  return JSON.parse(stdout.slice(jsonStart));
}

/**
 * @param {string} path
 * @param {Array<[string, string]>} replacements
 * @param {string} label
 */
function patchFile(path, replacements, label) {
  let text = readFileSync(path, "utf8");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  let changed = false;
  for (const [from, to] of replacements) {
    const fromText = from.replace(/\n/g, newline);
    const toText = to.replace(/\n/g, newline);
    if (text.includes(toText)) {
      continue;
    }
    if (!text.includes(fromText)) {
      throw new Error(`Could not apply ${label} patch to ${path}`);
    }
    text = text.replace(fromText, toText);
    changed = true;
  }
  if (changed) {
    writeFileSync(path, text);
    console.log(`Applied ${label} patch: ${path}`);
  } else {
    console.log(`${label} patch already applied: ${path}`);
  }
}

/** @param {string} path */
function isUsableFile(path) {
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
  const remaps = [
    [root, "<mgt-source>"],
    [process.env.USERPROFILE || process.env.HOME, "<build-home>"],
    [process.env.CARGO_HOME, "<cargo-home>"],
    [
      join(process.env.USERPROFILE || process.env.HOME || "", ".cargo"),
      "<cargo-home>",
    ],
  ];
  for (const [from, to] of remaps) {
    if (from && existsSync(from)) {
      flags.push(`--remap-path-prefix=${from}=${to}`);
    }
  }
  return flags.join(" ").trim();
}
