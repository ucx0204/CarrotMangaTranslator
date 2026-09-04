#!/usr/bin/env node
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { dirname, isAbsolute, join, relative, resolve } = require("node:path");
const {
  CANDIDATE_WORKERS,
  MINIMUM_ITERATIONS,
  PROFILE_RELATIVE_PATH,
  buildProfileRecord,
  createProfileBinding,
  isCiEnvironment,
  machineSupportsProfile,
  resolveWorkerResourceLimit,
  stableJson,
} = require("./vitest-worker-profile.cjs");

const root = join(__dirname, "..");

/** @param {string[]} args */
function parseArguments(args) {
  if (args.length === 1 && args[0] === "--help") {
    return { help: true, iterations: MINIMUM_ITERATIONS };
  }
  if (args.length !== 2 || args[0] !== "--iterations") {
    throw new Error(
      "Usage: node scripts/soak-vitest-workers.cjs --iterations 10",
    );
  }
  if (!/^[1-9]\d*$/u.test(args[1])) {
    throw new Error("--iterations must be a positive integer.");
  }
  const iterations = Number(args[1]);
  if (iterations < MINIMUM_ITERATIONS) {
    throw new Error(
      `A validated profile requires at least ${MINIMUM_ITERATIONS} iterations.`,
    );
  }
  return { help: false, iterations };
}

function printHelp() {
  console.log(
    `Runs Windows-local Vitest coverage at ${CANDIDATE_WORKERS.join("/")} workers in rotating order.`,
  );
  console.log(
    "Writes a machine/toolchain-bound profile only after identical tests and coverage.",
  );
  console.log("Usage: node scripts/soak-vitest-workers.cjs --iterations 10");
}

/**
 * Rotate the first candidate on every iteration so cache warmth, machine
 * temperature, and background activity do not consistently favor one worker
 * count. Iterations are one-based in the persisted diagnostic record.
 *
 * @param {number} iteration
 */
function workerOrderForIteration(iteration) {
  if (!Number.isSafeInteger(iteration) || iteration < 1) {
    throw new Error("Vitest soak iteration must be a positive integer.");
  }
  const offset = (iteration - 1) % CANDIDATE_WORKERS.length;
  return [
    ...CANDIDATE_WORKERS.slice(offset),
    ...CANDIDATE_WORKERS.slice(0, offset),
  ];
}

/** @param {number} workers @param {number} iteration @param {number} resourceLimit */
function runCoverageIteration(workers, iteration, resourceLimit) {
  const runDirectory = join(root, ".tmp", "vitest-worker-soak");
  const resultFile = join(runDirectory, `w${workers}-i${iteration}.json`);
  const coverageFile = join(root, "coverage", "coverage-summary.json");
  mkdirSync(runDirectory, { recursive: true });
  // A retried soak must never certify a run from a stale prior JSON report.
  // Successful Vitest coverage runs recreate both files below.
  for (const filePath of [resultFile, coverageFile]) {
    if (existsSync(filePath)) unlinkSync(filePath);
  }
  const started = Number(process.hrtime.bigint()) / 1_000_000;
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--coverage",
      "--reporter=json",
      `--outputFile=${resultFile}`,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        MGT_VITEST_MAX_WORKERS: String(workers),
      },
      shell: false,
      stdio: "inherit",
    },
  );
  const durationMs = Math.round(
    Number(process.hrtime.bigint()) / 1_000_000 - started,
  );
  /** @type {{ workers: number; iteration: number; durationMs: number; exitCode: number; resourceLimit: number; resourceSafe: boolean; error?: string }} */
  const run = {
    workers,
    iteration,
    durationMs,
    exitCode: result.status ?? 1,
    resourceLimit,
    resourceSafe: workers <= resourceLimit,
  };
  if (result.error) run.error = result.error.message;
  if (run.exitCode !== 0) return run;
  try {
    const testReport = JSON.parse(readFileSync(resultFile, "utf8"));
    const coverage = JSON.parse(readFileSync(coverageFile, "utf8"));
    return {
      ...run,
      testCounts: extractTestCounts(testReport),
      testDigest: digestTestReport(testReport),
      coverageDigest: sha256(stableJson(coverage)),
    };
  } catch (error) {
    return {
      ...run,
      exitCode: 1,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** @param {Record<string, unknown>} report */
function extractTestCounts(report) {
  const keys = [
    "numTotalTestSuites",
    "numPassedTestSuites",
    "numFailedTestSuites",
    "numPendingTestSuites",
    "numTotalTests",
    "numPassedTests",
    "numFailedTests",
    "numPendingTests",
    "numTodoTests",
  ];
  return Object.fromEntries(keys.map((key) => [key, Number(report[key] ?? 0)]));
}

/** @param {Record<string, unknown>} report */
function digestTestReport(report) {
  const testResults = Array.isArray(report.testResults)
    ? report.testResults
    : [];
  const assertions = testResults
    .flatMap((result) => {
      if (typeof result !== "object" || result === null) return [];
      const entries = /** @type {Record<string, unknown>} */ (result);
      if (!Array.isArray(entries.assertionResults)) return [];
      const file = normalizeTestFilePath(entries.name);
      return entries.assertionResults.map((assertion) => {
        if (typeof assertion !== "object" || assertion === null) {
          return { file, fullName: assertion, status: undefined };
        }
        const item = /** @type {Record<string, unknown>} */ (assertion);
        return {
          file,
          fullName: item.fullName,
          status: item.status,
        };
      });
    })
    .sort((left, right) =>
      stableJson(left).localeCompare(stableJson(right), "en"),
    );
  return sha256(stableJson({ counts: extractTestCounts(report), assertions }));
}

/** @param {unknown} value */
function normalizeTestFilePath(value) {
  if (typeof value !== "string") return value;
  const normalized = value.replaceAll("\\", "/");
  if (!isAbsolute(value)) return normalized;
  const repositoryRelative = relative(root, resolve(value));
  if (
    repositoryRelative &&
    !repositoryRelative.startsWith("..") &&
    !isAbsolute(repositoryRelative)
  ) {
    return repositoryRelative.replaceAll("\\", "/");
  }
  return normalized;
}

/** @param {string} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} filePath @param {unknown} value */
function writeJsonAtomically(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, filePath);
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (isCiEnvironment(process.env)) {
    throw new Error("Vitest worker profiling is local-only and refuses CI.");
  }
  if (process.platform !== "win32") {
    throw new Error("Vitest worker profiles may only be generated on Windows.");
  }
  const resourceLimit = resolveWorkerResourceLimit();
  if (!machineSupportsProfile()) {
    throw new Error(
      `Vitest worker profiling requires capacity for ${Math.max(...CANDIDATE_WORKERS)} workers; this machine safely allows ${resourceLimit}.`,
    );
  }

  const runs = [];
  for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
    for (const workers of workerOrderForIteration(iteration)) {
      console.log(
        `\n[vitest-soak] iteration ${iteration}/${options.iterations}, workers=${workers}`,
      );
      runs.push(runCoverageIteration(workers, iteration, resourceLimit));
    }
  }
  const profile = buildProfileRecord({
    binding: createProfileBinding(root),
    runs,
  });
  const profilePath = join(root, PROFILE_RELATIVE_PATH);
  writeJsonAtomically(profilePath, profile);
  console.log(`\n[vitest-soak] ${profile.reason}`);
  console.log(`[vitest-soak] profile: ${profilePath}`);
  if (!profile.validated) process.exitCode = 1;
}

module.exports = {
  digestTestReport,
  extractTestCounts,
  parseArguments,
  workerOrderForIteration,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
