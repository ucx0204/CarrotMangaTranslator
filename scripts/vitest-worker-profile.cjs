const { createHash } = require("node:crypto");
const { existsSync, readFileSync } = require("node:fs");
const { cpus, hostname, totalmem } = require("node:os");
const { join } = require("node:path");

const PROFILE_SCHEMA_VERSION = 1;
const DEFAULT_WORKERS = 4;
const CANDIDATE_WORKERS = [4, 6, 8];
const MINIMUM_ITERATIONS = 10;
const PROFILE_RELATIVE_PATH = join(".tmp", "vitest-worker-profile.json");

/** @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env */
function isCiEnvironment(env) {
  const value = env.CI;
  return (
    value !== undefined &&
    value !== "" &&
    value !== "0" &&
    value.toLowerCase() !== "false"
  );
}

/** @param {string} value */
function parseLocalWorkerCount(value) {
  if (!/^[1-9]\d*$/u.test(value)) throw invalidWorkerOverride();
  const workers = Number(value);
  if (!CANDIDATE_WORKERS.includes(workers)) throw invalidWorkerOverride();
  return workers;
}

function invalidWorkerOverride() {
  return new Error("MGT_VITEST_MAX_WORKERS must be one of 4, 6, or 8.");
}

/**
 * @param {string} root
 * @param {{
 *   arch?: string;
 *   cpuModels?: string[];
 *   hostname?: string;
 *   nodeVersion?: string;
 *   platform?: string;
 *   totalMemory?: number;
 * }} [system]
 */
function createProfileBinding(root, system = {}) {
  const machineDescriptor = {
    arch: system.arch ?? process.arch,
    cpuModels: system.cpuModels ?? cpus().map((cpu) => cpu.model),
    hostname: system.hostname ?? hostname(),
    platform: system.platform ?? process.platform,
    totalMemory: system.totalMemory ?? totalmem(),
  };
  const toolchainFiles = [
    "package-lock.json",
    "vitest.config.ts",
    join("scripts", "vitest-worker-profile.cjs"),
  ];
  const toolchainHash = createHash("sha256");
  for (const relativePath of toolchainFiles) {
    const filePath = join(root, relativePath);
    if (!existsSync(filePath)) {
      throw new Error(`Vitest profile input is missing: ${relativePath}`);
    }
    toolchainHash.update(relativePath.replaceAll("\\", "/"));
    toolchainHash.update("\0");
    toolchainHash.update(readFileSync(filePath));
    toolchainHash.update("\0");
  }
  return {
    machineSha256: sha256Json(machineDescriptor),
    nodeVersion: system.nodeVersion ?? process.versions.node,
    toolchainSha256: toolchainHash.digest("hex"),
  };
}

/**
 * @param {{
 *   binding?: ReturnType<typeof createProfileBinding>;
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
 *   platform?: string;
 *   profile?: unknown;
 *   root?: string;
 *   system?: { logicalCpuCount?: number; totalMemory?: number };
 * }} [options]
 */
function resolveVitestMaxWorkers(options = {}) {
  const env = options.env ?? process.env;
  const explicit = env.MGT_VITEST_MAX_WORKERS;
  if (isCiEnvironment(env)) {
    return DEFAULT_WORKERS;
  }
  if (explicit !== undefined && explicit !== "") {
    return parseLocalWorkerCount(explicit);
  }
  // Profiles currently prove result/coverage parity and bind to one machine
  // and toolchain. They deliberately remain advisory until the soak also
  // records peak RSS, handles, temporary I/O, and orphan-process counts.
  // Explicit local overrides are the only way to opt in above four workers.
  return DEFAULT_WORKERS;
}

/**
 * @param {{ binding: object; generatedAt?: string; runs: WorkerRun[] }} options
 */
function buildProfileRecord(options) {
  const candidateSummaries = CANDIDATE_WORKERS.map((workers) =>
    summarizeCandidateRuns(
      workers,
      options.runs.filter((run) => run.workers === workers),
    ),
  );
  const selection = selectValidatedWorkers(candidateSummaries);
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    binding: options.binding,
    candidates: [...CANDIDATE_WORKERS],
    minimumIterations: MINIMUM_ITERATIONS,
    selectionRule: {
      p50ImprovementMinimum: 0.1,
      p95ImprovementMinimum: 0.1,
      preferSixWithinEightP95: 0.05,
    },
    validated: selection.validated,
    activationEligible: false,
    diagnosticOnlyReason:
      "resource safety metrics (peak RSS, handles, temporary I/O, and orphan processes) are not recorded",
    selectedWorkers: selection.workers,
    reason: selection.reason,
    candidateSummaries,
    runs: options.runs,
  };
}

/**
 * @typedef {{
 *   coverageDigest?: string;
 *   durationMs: number;
 *   error?: string;
 *   exitCode: number;
 *   iteration: number;
 *   testDigest?: string;
 *   testCounts?: Record<string, number>;
 *   workers: number;
 * }} WorkerRun
 */

/** @param {number} workers @param {WorkerRun[]} runs */
function summarizeCandidateRuns(workers, runs) {
  const successful = runs.filter((run) => run.exitCode === 0);
  const durations = successful.map((run) => run.durationMs).sort(numberOrder);
  return {
    workers,
    iterations: runs.length,
    failures: runs.length - successful.length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    testDigests: uniqueSorted(successful.map((run) => run.testDigest)),
    coverageDigests: uniqueSorted(successful.map((run) => run.coverageDigest)),
    testCounts: uniqueSorted(
      successful.map((run) =>
        run.testCounts ? JSON.stringify(run.testCounts) : undefined,
      ),
    ),
  };
}

/** @param {ReturnType<typeof summarizeCandidateRuns>[]} summaries */
function selectValidatedWorkers(summaries) {
  const baseline = summaries.find(
    (summary) => summary.workers === DEFAULT_WORKERS,
  );
  const complete = summaries.every(
    (summary) =>
      summary.iterations >= MINIMUM_ITERATIONS &&
      summary.failures === 0 &&
      summary.testDigests.length === 1 &&
      summary.coverageDigests.length === 1 &&
      summary.testCounts.length === 1 &&
      summary.p50Ms > 0 &&
      summary.p95Ms > 0,
  );
  const allTestDigests = uniqueSorted(
    summaries.flatMap((summary) => summary.testDigests),
  );
  const allCoverageDigests = uniqueSorted(
    summaries.flatMap((summary) => summary.coverageDigests),
  );
  const allTestCounts = uniqueSorted(
    summaries.flatMap((summary) => summary.testCounts),
  );
  if (
    !baseline ||
    !complete ||
    allTestDigests.length !== 1 ||
    allCoverageDigests.length !== 1 ||
    allTestCounts.length !== 1
  ) {
    return {
      validated: false,
      workers: DEFAULT_WORKERS,
      reason:
        "runs failed, were incomplete, or produced different test/coverage results",
    };
  }

  const eligible = summaries
    .filter((summary) => summary.workers !== DEFAULT_WORKERS)
    .filter(
      (summary) =>
        summary.p50Ms <= baseline.p50Ms * 0.9 &&
        summary.p95Ms <= baseline.p95Ms * 0.9,
    );
  const six = eligible.find((summary) => summary.workers === 6);
  const eight = eligible.find((summary) => summary.workers === 8);
  const selected =
    six && eight && six.p95Ms <= eight.p95Ms * 1.05
      ? six
      : [...eligible].sort((left, right) => left.p95Ms - right.p95Ms)[0];
  return selected
    ? {
        validated: true,
        workers: selected.workers,
        reason: "selected worker count clears the 10% p50/p95 rules",
      }
    : {
        validated: true,
        workers: DEFAULT_WORKERS,
        reason: "no candidate safely outperformed the four-worker baseline",
      };
}

/**
 * @param {{ logicalCpuCount?: number; totalMemory?: number }} [system]
 */
function machineSupportsProfile(system = {}) {
  const logicalCpuCount = system.logicalCpuCount ?? cpus().length;
  const totalMemory = system.totalMemory ?? totalmem();
  return logicalCpuCount >= 16 && totalMemory >= 32 * 1024 ** 3;
}

/** @param {unknown} value @param {object} expectedBinding */
function isValidatedProfile(value, expectedBinding) {
  if (typeof value !== "object" || value === null) return false;
  const profile = /** @type {Record<string, unknown>} */ (value);
  if (
    profile.schemaVersion !== PROFILE_SCHEMA_VERSION ||
    profile.validated !== true ||
    profile.activationEligible !== false ||
    !CANDIDATE_WORKERS.includes(Number(profile.selectedWorkers)) ||
    sha256Json(profile.binding) !== sha256Json(expectedBinding) ||
    !Array.isArray(profile.runs)
  ) {
    return false;
  }
  const rebuilt = buildProfileRecord({
    binding: expectedBinding,
    generatedAt: String(profile.generatedAt ?? ""),
    runs: /** @type {WorkerRun[]} */ (profile.runs),
  });
  return (
    rebuilt.activationEligible === false &&
    rebuilt.validated &&
    rebuilt.selectedWorkers === profile.selectedWorkers &&
    JSON.stringify(rebuilt.candidateSummaries) ===
      JSON.stringify(profile.candidateSummaries)
  );
}

/** @param {number[]} values @param {number} quantile */
function percentile(values, quantile) {
  if (values.length === 0) return 0;
  return values[Math.max(0, Math.ceil(values.length * quantile) - 1)];
}

/** @param {(string | undefined)[]} values */
function uniqueSorted(values) {
  return [
    ...new Set(values.filter((value) => typeof value === "string")),
  ].sort();
}

/** @param {number} left @param {number} right */
function numberOrder(left, right) {
  return left - right;
}

/** @param {unknown} value */
function sha256Json(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/** @param {unknown} value @returns {string} */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

module.exports = {
  CANDIDATE_WORKERS,
  DEFAULT_WORKERS,
  MINIMUM_ITERATIONS,
  PROFILE_RELATIVE_PATH,
  buildProfileRecord,
  createProfileBinding,
  isCiEnvironment,
  isValidatedProfile,
  machineSupportsProfile,
  parseLocalWorkerCount,
  resolveVitestMaxWorkers,
  selectValidatedWorkers,
  stableJson,
};
