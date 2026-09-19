// @ts-check
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} = require("node:fs");
const { execFileSync, spawnSync } = require("node:child_process");
const { dirname, join, delimiter, resolve } = require("node:path");

/** Pin PTX to Turing, not the GPU installed on the build host. PTX is
 * forward-JIT compatible with newer NVIDIA architectures. This is not a
 * claim that hardware inference or driver compatibility has been tested. */
const KOHARU_CUDA_COMPUTE_CAP = "75";

/** @param {Buffer} executable */
function assertPortableKoharuPtx(executable) {
  const targets = [
    ...executable.toString("latin1").matchAll(/\.target\s+sm_([0-9]+[a-z]*)/g),
  ].map((match) => match[1]);
  if (
    targets.length === 0 ||
    targets.some((target) => target !== KOHARU_CUDA_COMPUTE_CAP)
  ) {
    throw new Error(
      `Koharu runner must contain portable sm_75 PTX, found: ${[...new Set(targets)].join(", ") || "none"}. Run npm run build:koharu-cuda-runner.`,
    );
  }
}

/** @param {string} root @param {NodeJS.ProcessEnv} env */
function koharuCudaBuildEnv(root, env) {
  const cudaRoot =
    env.MGT_KOHARU_CUDA_ROOT ||
    env.CUDA_PATH_V12_9 ||
    "C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA/v12.9";
  const remaps = [];
  if (env.USERPROFILE)
    remaps.push(`--remap-path-prefix=${env.USERPROFILE}=/user`);
  remaps.push(`--remap-path-prefix=${root}=/src`);
  return {
    ...env,
    PATH: env.PATH || "",
    CUDA_COMPUTE_CAP: KOHARU_CUDA_COMPUTE_CAP,
    CUDA_PATH: cudaRoot,
    CUDACXX: join(cudaRoot, "bin", "nvcc.exe"),
    CARGO_TARGET_DIR:
      env.MGT_KOHARU_TARGET_DIR || join(root, ".tmp", "koharu-sm75"),
    CARGO_BUILD_JOBS: env.CARGO_BUILD_JOBS || "4",
    CARGO_ENCODED_RUSTFLAGS: [env.CARGO_ENCODED_RUSTFLAGS, ...remaps]
      .filter(Boolean)
      .join("\x1f"),
  };
}

/** @param {string} root */
function prepareKoharuCudaRunner(root) {
  if (process.platform !== "win32")
    throw new Error(
      "Use build:mac:runners for Metal; this builds the Windows CUDA/ZLUDA runner.",
    );
  const output = join(
    root,
    "tools",
    "mgt-koharu-inpaint-runner",
    "mgt-koharu-inpaint-runner.exe",
  );
  if (process.argv.includes("--check")) {
    assertPortableKoharuPtx(readFileSync(output));
    console.log("Koharu portable sm_75 PTX check passed");
    return;
  }
  const env = koharuCudaBuildEnv(root, process.env);
  const version = execFileSync(env.CUDACXX, ["--version"], {
    encoding: "utf8",
  });
  if (!/release 12\.9\b/.test(version))
    throw new Error(
      "Koharu runner must be built with CUDA 12.9 to match the managed runtime.",
    );
  const vswhere = join(
    process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  const cl = execFileSync(
    vswhere,
    [
      "-latest",
      "-products",
      "*",
      "-find",
      "VC/Tools/MSVC/**/bin/Hostx64/x64/cl.exe",
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split(/\r?\n/)[0];
  if (!cl || !existsSync(cl)) throw new Error("MSVC x64 compiler not found");
  env.PATH = [join(env.CUDA_PATH, "bin"), dirname(cl), process.env.PATH]
    .filter(Boolean)
    .join(delimiter);
  const result = spawnSync(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "--manifest-path",
      join(root, "tools", "mgt-koharu-inpaint-runner", "Cargo.toml"),
    ],
    { cwd: root, env, stdio: "inherit", shell: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Koharu cargo build failed (${result.status})`);
  const built = join(
    env.CARGO_TARGET_DIR,
    "release",
    "mgt-koharu-inpaint-runner.exe",
  );
  assertPortableKoharuPtx(readFileSync(built));
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(built, output);
}

module.exports = { assertPortableKoharuPtx, koharuCudaBuildEnv };
if (require.main === module) prepareKoharuCudaRunner(resolve(__dirname, ".."));
