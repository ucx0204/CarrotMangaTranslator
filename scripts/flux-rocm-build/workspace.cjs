/** @typedef {{ [key: string]: string | boolean | undefined; out?: string; force?: boolean; "work-dir"?: string; "runtime-dir"?: string; "keep-work"?: boolean; "gpu-targets"?: string }} BuildArgs
 * @typedef {{ line(text: string): void; raw(text: string): void; close(): void }} BuildLogger
 */
const {
  createWriteStream,
  existsSync,
  mkdirSync,
  statfsSync,
} = require("node:fs");
const os = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { formatBytes } = require("./build-utils.cjs");
const {
  minimumBuildFreeBytes,
  minimumOutputFreeBytes,
  recommendedBuildFreeBytes,
} = require("./config.cjs");

/**
 * @param {string[]} argv
 * @returns {BuildArgs}
 */
function parseArgs(argv) {
  /** @type {BuildArgs} */
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

/**
 * @param {string} stamp
 * @param {string} outputPath
 * @returns {string}
 */
function resolveDefaultWorkDir(stamp, outputPath) {
  const explicitRoot =
    process.env.MGT_FLUX_ROCM_BUILD_ROOT || process.env.MGT_FLUX_BUILD_ROOT;
  if (explicitRoot) {
    return join(explicitRoot, stamp);
  }

  const candidates = uniqueTruthy([
    isAsciiPath(dirname(outputPath))
      ? join(dirname(outputPath), ".mgt-flux-rocm-runtime-build")
      : "",
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "mgt-flux-rocm-runtime-build")
      : "",
    join(os.tmpdir(), "mgt-flux-rocm-runtime-build"),
    ...resolveWindowsScratchDriveCandidates(),
  ]).filter(isAsciiPath);

  const scored = candidates
    .map((pathValue, index) => ({
      pathValue,
      index,
      freeBytes: getPathFreeBytes(pathValue),
    }))
    .filter(hasFreeBytes)
    .sort((left, right) => {
      const rightEnough = right.freeBytes >= recommendedBuildFreeBytes;
      const leftEnough = left.freeBytes >= recommendedBuildFreeBytes;
      if (leftEnough !== rightEnough) {
        return leftEnough ? -1 : 1;
      }
      if (right.freeBytes !== left.freeBytes) {
        return right.freeBytes - left.freeBytes;
      }
      return left.index - right.index;
    });

  const base =
    scored[0]?.pathValue || candidates[0] || "C:\\mgt-flux-rocm-runtime-build";
  return join(base, stamp);
}

/**
 * @param {{ pathValue: string; index: number; freeBytes: number | null }} item
 * @returns {item is { pathValue: string; index: number; freeBytes: number }}
 */
function hasFreeBytes(item) {
  return item.freeBytes !== null;
}

/**
 * @param {string} pathValue
 * @returns {boolean}
 */
function isAsciiPath(pathValue) {
  return /^[\x00-\x7F]+$/.test(String(pathValue));
}

/**
 * @param {Iterable<unknown>} values
 * @returns {string[]}
 */
function uniqueTruthy(values) {
  const seen = new Set();
  /** @type {string[]} */
  const result = [];
  for (const value of values) {
    if (!value) {
      continue;
    }
    const key = String(value).toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(String(value));
  }
  return result;
}

/**
 * @returns {string[]}
 */
function resolveWindowsScratchDriveCandidates() {
  if (process.platform !== "win32") {
    return [];
  }
  const result = [];
  for (let code = "C".charCodeAt(0); code <= "Z".charCodeAt(0); code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (existsSync(root)) {
      result.push(join(root, "mgt-flux-rocm-runtime-build"));
    }
  }
  return result;
}

/**
 * @param {{ workDir: string; outputPath: string; logger: BuildLogger }} options
 * @returns {void}
 */
function ensureBuildDiskSpace({ workDir, outputPath, logger }) {
  const workFreeBytes = getPathFreeBytes(workDir);
  const outputFreeBytes = getPathFreeBytes(dirname(outputPath));
  if (workFreeBytes !== null && workFreeBytes < minimumBuildFreeBytes) {
    throw new Error(
      [
        `Not enough free space for ROCm runtime build workDir: ${workDir}`,
        `Available: ${formatBytes(workFreeBytes)}, required minimum: ${formatBytes(minimumBuildFreeBytes)}.`,
        "Set MGT_FLUX_ROCM_BUILD_ROOT to a spacious ASCII path, for example:",
        "  $env:MGT_FLUX_ROCM_BUILD_ROOT='D:\\mgt-flux-rocm-runtime-build'",
      ].join("\n"),
    );
  }
  if (outputFreeBytes !== null && outputFreeBytes < minimumOutputFreeBytes) {
    throw new Error(
      [
        `Not enough free space for ROCm runtime ZIP output: ${dirname(outputPath)}`,
        `Available: ${formatBytes(outputFreeBytes)}, required minimum: ${formatBytes(minimumOutputFreeBytes)}.`,
        "Pass --out to a drive with more space or free up the output drive.",
      ].join("\n"),
    );
  }
  if (workFreeBytes !== null && workFreeBytes < recommendedBuildFreeBytes) {
    logger.line(
      `warning: workDir has ${formatBytes(workFreeBytes)} free; ${formatBytes(recommendedBuildFreeBytes)}+ is recommended for ROCm wheel builds.`,
    );
  }
}

/**
 * @param {string} pathValue
 * @returns {number | null}
 */
function getPathFreeBytes(pathValue) {
  let current = resolve(pathValue);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  try {
    const stat = statfsSync(current, { bigint: true });
    return Number(stat.bavail * stat.bsize);
  } catch (_error) {
    return null;
  }
}

/**
 * @param {number | null} bytes
 * @returns {string}
 */
function formatOptionalBytes(bytes) {
  return bytes === null ? "unknown" : formatBytes(bytes);
}

/**
 * @param {string} logPath
 * @returns {BuildLogger}
 */
function createLogger(logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  const stream = createWriteStream(logPath, { flags: "a" });
  return {
    /** @param {string} text */
    line(text) {
      const line = `[${new Date().toISOString()}] ${text}`;
      console.log(line);
      stream.write(`${line}\n`);
    },
    /** @param {string} text */
    raw(text) {
      process.stdout.write(text);
      stream.write(text);
    },
    close() {
      stream.end();
    },
  };
}

module.exports = {
  createLogger,
  ensureBuildDiskSpace,
  formatOptionalBytes,
  getPathFreeBytes,
  parseArgs,
  resolveDefaultWorkDir,
};
