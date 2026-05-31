const { copyFileSync, existsSync, mkdirSync, statSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { delimiter, join } = require("node:path");
const { spawnSync } = require("node:child_process");

const root = join(__dirname, "..");
const manifestPath = join(root, "tools", "mgt-flux-klein-runner", "Cargo.toml");
const outDir = join(root, "tools", "mgt-flux-klein");
const outExe = join(outDir, "mgt-flux-klein.exe");
const cargoTargetDir = process.env.MGT_FLUX_KLEIN_TARGET_DIR || join(tmpdir(), "mgt-flux-klein-target");
const builtExe = join(cargoTargetDir, "release", "mgt-flux-klein.exe");
const cudaRoot = process.env.MGT_FLUX_KLEIN_CUDA_ROOT || findCudaRoot();

if (isUsableFile(outExe)) {
  console.log(`mgt-flux-klein already exists: ${outExe}`);
  process.exit(0);
}

if (!existsSync(manifestPath)) {
  console.error(`Missing Flux runner manifest: ${manifestPath}`);
  process.exit(1);
}

runCargo(["build", "--release", "--manifest-path", manifestPath]);
if (!isUsableFile(builtExe)) {
  console.error(`Flux runner build did not produce ${builtExe}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
copyFileSync(builtExe, outExe);
console.log(`Prepared Flux runner: ${outExe}`);

function runCargo(args) {
  const msvcBin = process.platform === "win32" ? findMsvcClBin() : null;
  const pathParts = [
    cudaRoot ? join(cudaRoot, "bin") : null,
    msvcBin,
    process.env.PATH ?? ""
  ].filter(Boolean);
  run("cargo", args, {
    CARGO_TARGET_DIR: cargoTargetDir,
    LLAMA_CPP_TAG: "b-mgt-unused",
    ...(cudaRoot
      ? {
          CUDA_PATH: cudaRoot,
          CUDA_HOME: cudaRoot,
          CUDA_ROOT: cudaRoot,
          CUDACXX: join(cudaRoot, "bin", "nvcc.exe")
        }
      : {}),
    PATH: pathParts.join(delimiter)
  });
}

function run(command, args, extraEnv = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      ...extraEnv
    }
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
    join("C:", "Program Files", "Microsoft Visual Studio", "2022", "Community", "VC", "Tools", "MSVC"),
    join("C:", "Program Files", "Microsoft Visual Studio", "2022", "BuildTools", "VC", "Tools", "MSVC"),
    join("C:", "Program Files", "Microsoft Visual Studio", "2022", "Professional", "VC", "Tools", "MSVC"),
    join("C:", "Program Files", "Microsoft Visual Studio", "2022", "Enterprise", "VC", "Tools", "MSVC")
  ];
  for (const root of candidates) {
    if (!existsSync(root)) {
      continue;
    }
    const versions = require("node:fs")
      .readdirSync(root)
      .sort()
      .reverse();
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
  const candidates = [
    process.env.CUDA_PATH_V12_8,
    process.env.CUDA_PATH_V12_4,
    join("C:", "Program Files", "NVIDIA GPU Computing Toolkit", "CUDA", "v12.8"),
    join("C:", "Program Files", "NVIDIA GPU Computing Toolkit", "CUDA", "v12.4"),
    process.env.CUDA_PATH,
    process.env.CUDA_HOME
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(join(candidate, "bin", "nvcc.exe"))) || null;
}

function isUsableFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile() && statSync(path).size > 1024 * 1024;
  } catch {
    return false;
  }
}
