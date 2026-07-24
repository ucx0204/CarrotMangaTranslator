// @ts-check

const { join } = require("node:path");

/**
 * @typedef {{ outDir: string; outExe: string }} FluxBuildAlias
 * @typedef {{
 *   computeCap: string | null;
 *   cargoTargetDir: string;
 *   outDir: string;
 *   outExe: string;
 *   aliases: FluxBuildAlias[];
 * }} FluxBuildTarget
 * @typedef {{
 *   root: string;
 *   cargoTargetDir: string;
 *   computeCaps?: unknown;
 *   singleComputeCap?: unknown;
 *   runnerDirName?: string;
 *   runnerExeName?: string;
 * }} FluxBuildPlanOptions
 * @typedef {{
 *   manifestPath: string;
 *   buildTarget: FluxBuildTarget;
 *   cudaRoot: string | null;
 *   msvcBin: string | null;
 *   rustFlags: string;
 *   basePath: string;
 *   pathDelimiter: string;
 * }} FluxCargoInvocationOptions
 */

/**
 * @param {FluxBuildPlanOptions} options
 * @returns {FluxBuildTarget[]}
 */
function createFluxKleinBuildPlan(options) {
  const runnerDirName = options.runnerDirName ?? "mgt-flux-klein";
  const runnerExeName = options.runnerExeName ?? "mgt-flux-klein.exe";
  const genericOutDir = join(options.root, "tools", runnerDirName);
  const genericOutExe = join(genericOutDir, runnerExeName);
  const requestedCaps = parseComputeCaps(options.computeCaps);

  if (requestedCaps.length > 0) {
    return requestedCaps.map((computeCap, index) =>
      createComputeTarget({
        root: options.root,
        cargoTargetDir: options.cargoTargetDir,
        runnerDirName,
        runnerExeName,
        computeCap,
        aliases:
          index === 0 ? [{ outDir: genericOutDir, outExe: genericOutExe }] : [],
      }),
    );
  }

  const singleComputeCap = normalizeComputeCap(options.singleComputeCap);
  if (singleComputeCap) {
    return [
      createComputeTarget({
        root: options.root,
        cargoTargetDir: options.cargoTargetDir,
        runnerDirName,
        runnerExeName,
        computeCap: singleComputeCap,
        aliases: [{ outDir: genericOutDir, outExe: genericOutExe }],
      }),
    ];
  }

  return [
    {
      computeCap: null,
      cargoTargetDir: options.cargoTargetDir,
      outDir: genericOutDir,
      outExe: genericOutExe,
      aliases: [],
    },
  ];
}

/**
 * @param {{
 *   root: string;
 *   cargoTargetDir: string;
 *   runnerDirName: string;
 *   runnerExeName: string;
 *   computeCap: string;
 *   aliases: FluxBuildAlias[];
 * }} options
 * @returns {FluxBuildTarget}
 */
function createComputeTarget(options) {
  const dirName = `${options.runnerDirName}-sm${options.computeCap}`;
  const outDir = join(options.root, "tools", dirName);
  return {
    computeCap: options.computeCap,
    cargoTargetDir: join(options.cargoTargetDir, `sm${options.computeCap}`),
    outDir,
    outExe: join(outDir, options.runnerExeName),
    aliases: options.aliases,
  };
}

/**
 * @param {FluxCargoInvocationOptions} options
 * @returns {{ command: "cargo"; args: string[]; env: NodeJS.ProcessEnv }}
 */
function createFluxCargoInvocation(options) {
  const pathParts = [
    options.cudaRoot ? join(options.cudaRoot, "bin") : null,
    options.msvcBin,
    options.basePath,
  ].filter(
    /** @returns {candidate is string} */
    (candidate) => typeof candidate === "string" && candidate.length > 0,
  );
  const computeEnv = options.buildTarget.computeCap
    ? { CUDA_COMPUTE_CAP: options.buildTarget.computeCap }
    : {};
  const cudaEnv = options.cudaRoot
    ? {
        CUDA_PATH: options.cudaRoot,
        CUDA_HOME: options.cudaRoot,
        CUDA_ROOT: options.cudaRoot,
        CUDACXX: join(options.cudaRoot, "bin", "nvcc.exe"),
      }
    : {};

  return {
    command: "cargo",
    args: ["build", "--release", "--manifest-path", options.manifestPath],
    env: {
      CARGO_TARGET_DIR: options.buildTarget.cargoTargetDir,
      LLAMA_CPP_TAG: "b-mgt-unused",
      RUSTFLAGS: options.rustFlags,
      ...computeEnv,
      ...cudaEnv,
      PATH: pathParts.join(options.pathDelimiter),
    },
  };
}

/**
 * CUDA 12.9 is the supported build ABI. Later or legacy toolkits are only
 * candidates after an explicit opt-in.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Array<string | undefined>}
 */
function createCudaRootCandidates(env) {
  return [
    env.CUDA_PATH_V12_9,
    join(
      "C:",
      "Program Files",
      "NVIDIA GPU Computing Toolkit",
      "CUDA",
      "v12.9",
    ),
    env.CUDA_PATH_V12_8,
    join(
      "C:",
      "Program Files",
      "NVIDIA GPU Computing Toolkit",
      "CUDA",
      "v12.8",
    ),
    env.CUDA_PATH_V12_6,
    join(
      "C:",
      "Program Files",
      "NVIDIA GPU Computing Toolkit",
      "CUDA",
      "v12.6",
    ),
    ...(env.MGT_FLUX_ALLOW_LEGACY_CUDA_BUILD === "1"
      ? [
          env.CUDA_PATH_V12_4,
          join(
            "C:",
            "Program Files",
            "NVIDIA GPU Computing Toolkit",
            "CUDA",
            "v12.4",
          ),
          env.CUDA_PATH,
          env.CUDA_HOME,
        ]
      : []),
    ...(env.MGT_FLUX_ALLOW_CUDA13_BUILD === "1"
      ? [
          env.CUDA_PATH_V13_1,
          join(
            "C:",
            "Program Files",
            "NVIDIA GPU Computing Toolkit",
            "CUDA",
            "v13.1",
          ),
          env.CUDA_PATH_V13_0,
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
}

/** @param {unknown} value @returns {string[]} */
function parseComputeCaps(value) {
  return String(value ?? "")
    .split(/[,\s;]+/)
    .map(normalizeComputeCap)
    .filter((cap) => typeof cap === "string")
    .filter((cap, index, values) => values.indexOf(cap) === index);
}

/** @param {unknown} value @returns {string | null} */
function normalizeComputeCap(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^sm[_-]?/, "")
    .replace(/^compute[_-]?/, "")
    .replace(/\./g, "");
  return /^\d{2,3}$/.test(normalized) ? normalized : null;
}

module.exports = {
  createCudaRootCandidates,
  createFluxCargoInvocation,
  createFluxKleinBuildPlan,
  normalizeComputeCap,
  parseComputeCaps,
};
