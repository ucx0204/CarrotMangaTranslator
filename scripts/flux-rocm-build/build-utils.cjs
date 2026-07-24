/**
 * @typedef {{ [key: string]: string | boolean | undefined; "gpu-targets"?: string }} BuildArgs
 * @typedef {{ sdkVersion?: string; pathEntries: string[]; includePaths: string[]; libPaths: string[] }} NativeBuildEnv
 */
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
const os = require("node:os");
const {
  defaultAmdGpuTargets,
  pythonVersion,
  rocmVersion,
  rootDir,
} = require("./config.cjs");
const {
  resolveWindowsRuntimeLibraryPaths,
} = require("./windows-native-tools.cjs");

/**
 * @param {BuildArgs} args
 * @returns {string}
 */
function resolveGpuTargets(args) {
  const value =
    args["gpu-targets"] ||
    process.env.MANGA_TRANSLATOR_AMDGPU_TARGETS ||
    process.env.MGT_AMDGPU_TARGETS ||
    process.env.AMDGPU_TARGETS ||
    process.env.GPU_TARGETS ||
    "";
  const targets = String(value)
    .split(/[,\s;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .join(";");
  return targets || defaultAmdGpuTargets.join(";");
}

/**
 * @param {NativeBuildEnv} nativeBuildEnv
 * @param {string} gpuTargets
 * @returns {Record<string, unknown>}
 */
function snapshotEnvironment(nativeBuildEnv, gpuTargets) {
  const runtimeLibraries = (() => {
    try {
      return resolveWindowsRuntimeLibraryPaths(nativeBuildEnv.libPaths);
    } catch (_error) {
      return [];
    }
  })();
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    os: `${os.type()} ${os.release()}`,
    cwd: process.cwd(),
    rootDir,
    rocmVersion,
    pythonVersion,
    gpuTargets: gpuTargets ? gpuTargets.split(";") : [],
    env: {
      ROCM_PATH: process.env.ROCM_PATH || null,
      HIP_PATH: process.env.HIP_PATH || null,
      GPU_TARGETS: process.env.GPU_TARGETS || null,
      AMDGPU_TARGETS: process.env.AMDGPU_TARGETS || null,
      CMAKE_GENERATOR: process.env.CMAKE_GENERATOR || null,
    },
    nativeBuildEnv,
    runtimeLibraries,
  };
}

function readGitRevision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
    }).trim();
  } catch (error) {
    void error;
    return null;
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function quoteArg(value) {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

/**
 * @param {string} value
 * @returns {string}
 */
function quoteCmakeArg(value) {
  return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
function sha256File(filePath) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

module.exports = {
  formatBytes,
  quoteArg,
  quoteCmakeArg,
  readGitRevision,
  resolveGpuTargets,
  sha256File,
  snapshotEnvironment,
};
