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

const root = join(__dirname, "..");
const manifestPath = join(root, "tools", "mgt-flux-klein-runner", "Cargo.toml");
const runnerDirName = "mgt-flux-klein";
const runnerExeName = "mgt-flux-klein.exe";
const outDir = join(root, "tools", runnerDirName);
const outExe = join(outDir, runnerExeName);
const cargoTargetDir =
  process.env.MGT_FLUX_KLEIN_TARGET_DIR ||
  join(tmpdir(), "mgt-flux-klein-target");
const cudaRoot = process.env.MGT_FLUX_KLEIN_CUDA_ROOT || findCudaRoot();
const forceRebuild = process.env.MGT_FORCE_REBUILD_FLUX_RUNNER === "1";
const buildPlan = resolveBuildPlan();

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

patchKoharuFluxSources();
for (const entry of buildPlan) {
  runCargo(["build", "--release", "--manifest-path", manifestPath], entry);
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

function runCargo(args, buildTarget) {
  const msvcBin = process.platform === "win32" ? findMsvcClBin() : null;
  const pathParts = [
    cudaRoot ? join(cudaRoot, "bin") : null,
    msvcBin,
    process.env.PATH ?? "",
  ].filter(
    (candidate) => typeof candidate === "string" && candidate.length > 0,
  );
  if (buildTarget.computeCap) {
    console.log(`CUDA_COMPUTE_CAP=${buildTarget.computeCap}`);
  }
  run("cargo", args, {
    CARGO_TARGET_DIR: buildTarget.cargoTargetDir,
    LLAMA_CPP_TAG: "b-mgt-unused",
    RUSTFLAGS: buildRustFlags(),
    ...(buildTarget.computeCap
      ? {
          CUDA_COMPUTE_CAP: buildTarget.computeCap,
        }
      : {}),
    ...(cudaRoot
      ? {
          CUDA_PATH: cudaRoot,
          CUDA_HOME: cudaRoot,
          CUDA_ROOT: cudaRoot,
          CUDACXX: join(cudaRoot, "bin", "nvcc.exe"),
        }
      : {}),
    PATH: pathParts.join(delimiter),
  });
}

function resolveBuildPlan() {
  const requestedCaps = parseComputeCaps(
    process.env.MGT_FLUX_KLEIN_COMPUTE_CAPS,
  );
  if (requestedCaps.length > 0) {
    return requestedCaps.map((computeCap, index) =>
      makeBuildTarget(computeCap, index === 0 ? [{ outDir, outExe }] : []),
    );
  }

  const singleComputeCap = normalizeComputeCap(process.env.CUDA_COMPUTE_CAP);
  if (singleComputeCap) {
    return [makeBuildTarget(singleComputeCap, [{ outDir, outExe }])];
  }

  return [
    {
      computeCap: null,
      cargoTargetDir,
      outDir,
      outExe,
      aliases: [],
    },
  ];
}

function makeBuildTarget(computeCap, aliases) {
  const dirName = `${runnerDirName}-sm${computeCap}`;
  return {
    computeCap,
    cargoTargetDir: join(cargoTargetDir, `sm${computeCap}`),
    outDir: join(root, "tools", dirName),
    outExe: join(root, "tools", dirName, runnerExeName),
    aliases,
  };
}

function parseComputeCaps(value) {
  return String(value ?? "")
    .split(/[,\s;]+/)
    .map(normalizeComputeCap)
    .filter(Boolean)
    .filter((cap, index, values) => values.indexOf(cap) === index);
}

function normalizeComputeCap(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^sm[_-]?/, "")
    .replace(/^compute[_-]?/, "")
    .replace(/\./g, "");
  return /^\d{2,3}$/.test(normalized) ? normalized : null;
}

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

function findCudaRoot() {
  const rawCandidates = [
    process.env.CUDA_PATH_V12_9,
    join(
      "C:",
      "Program Files",
      "NVIDIA GPU Computing Toolkit",
      "CUDA",
      "v12.9",
    ),
    process.env.CUDA_PATH_V12_8,
    join(
      "C:",
      "Program Files",
      "NVIDIA GPU Computing Toolkit",
      "CUDA",
      "v12.8",
    ),
    process.env.CUDA_PATH_V12_6,
    join(
      "C:",
      "Program Files",
      "NVIDIA GPU Computing Toolkit",
      "CUDA",
      "v12.6",
    ),
    ...(process.env.MGT_FLUX_ALLOW_LEGACY_CUDA_BUILD === "1"
      ? [
          process.env.CUDA_PATH_V12_4,
          join(
            "C:",
            "Program Files",
            "NVIDIA GPU Computing Toolkit",
            "CUDA",
            "v12.4",
          ),
          process.env.CUDA_PATH,
          process.env.CUDA_HOME,
        ]
      : []),
    ...(process.env.MGT_FLUX_ALLOW_CUDA13_BUILD === "1"
      ? [
          process.env.CUDA_PATH_V13_1,
          join(
            "C:",
            "Program Files",
            "NVIDIA GPU Computing Toolkit",
            "CUDA",
            "v13.1",
          ),
          process.env.CUDA_PATH_V13_0,
          join(
            "C:",
            "Program Files",
            "NVIDIA GPU Computing Toolkit",
            "CUDA",
            "v13.0",
          ),
        ]
      : []),
  ];
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
  patchFile(
    join(koharuMlDir, "src", "flux2_klein", "mod.rs"),
    [
      [
        `fn transformer_dtype(device: &Device) -> DType {\n    if device.is_cuda() {\n        return DType::BF16;\n    }\n\n    DType::F32\n}\n\nfn vae_dtype(device: &Device) -> DType {\n    if device.is_cuda() {\n        return DType::BF16;\n    }\n\n    DType::F32\n}`,
        `fn transformer_dtype(device: &Device) -> DType {\n    if device.is_cuda() && !koharu_runtime::zluda_active() {\n        return DType::BF16;\n    }\n\n    DType::F32\n}\n\nfn vae_dtype(device: &Device) -> DType {\n    if device.is_cuda() && !koharu_runtime::zluda_active() {\n        return DType::BF16;\n    }\n\n    DType::F32\n}`,
      ],
    ],
    "ZLUDA Flux dtype",
  );
  patchFile(
    join(koharuMlDir, "src", "flux2_klein", "transformer.rs"),
    [
      [
        `    #[cfg(feature = "cuda")]\n    if q.device().is_cuda() {\n`,
        `    #[cfg(feature = "cuda")]\n    if q.device().is_cuda() && !koharu_runtime::zluda_active() {\n`,
      ],
    ],
    "ZLUDA Flux attention",
  );
}

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
