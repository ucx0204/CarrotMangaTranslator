const { createHash } = require("node:crypto");
const { existsSync, readFileSync } = require("node:fs");
const {
  availableParallelism,
  cpus,
  freemem,
  hostname,
  totalmem,
} = require("node:os");
const { join } = require("node:path");

const PROFILE_SCHEMA_VERSION = 2;
const DEFAULT_WORKERS = 12;
const MAX_EXPLICIT_WORKERS = 16;
const CANDIDATE_WORKERS = [4, 12, 16];
const MINIMUM_ITERATIONS = 10;
const PROFILE_RELATIVE_PATH = join(".tmp", "vitest-worker-profile.json");
const WORKER_MEMORY_BYTES = 2 * 1024 ** 3;

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

/** @param {string} value @param {number} [resourceLimit] */
function parseLocalWorkerCount(
  value,
  resourceLimit = resolveWorkerResourceLimit(),
) {
  if (!/^[1-9]\d*$/u.test(value)) throw invalidWorkerOverride();
  const workers = Number(value);
  if (workers > Math.min(MAX_EXPLICIT_WORKERS, resourceLimit)) {
    throw invalidWorkerOverride(resourceLimit);
  }
  return workers;
}

/** @param {number} [resourceLimit] */
function invalidWorkerOverride(resourceLimit = resolveWorkerResourceLimit()) {
  return new Error(
    `MGT_VITEST_MAX_WORKERS must be an integer from 1 to ${Math.min(MAX_EXPLICIT_WORKERS, resourceLimit)} for the available CPU and memory.`,
  );
}

/**
 * @param {{ logicalCpuCount?: number; freeMemory?: number; totalMemory?: number }} [system]
 */
function resolveWorkerResourceLimit(system = {}) {
  const logicalCpuCount = Math.max(
    1,
    Math.floor(system.logicalCpuCount ?? availableParallelism()),
  );
  const availableMemory = Math.max(
    0,
    system.freeMemory ?? system.totalMemory ?? freemem(),
  );
  const memoryWorkers = Math.max(
    1,
    Math.floor(availableMemory / WORKER_MEMORY_BYTES),
  );
  return Math.max(
    1,
    Math.min(MAX_EXPLICIT_WORKERS, logicalCpuCount, memoryWorkers),
  );
}

/**
 * @param {{ logicalCpuCount?: number; freeMemory?: number; totalMemory?: number }} [system]
 */
function resolveResourceAwareDefault(system = {}) {
  const logicalCpuCount = Math.max(
    1,
    Math.floor(system.logicalCpuCount ?? availableParallelism()),
  );
  const cpuCandidate = Math.min(
    DEFAULT_WORKERS,
    Math.max(4, Math.floor(logicalCpuCount / 2)),
  );
  return Math.max(
    1,
    Math.min(logicalCpuCount, cpuCandidate, resolveWorkerResourceLimit(system)),
  );
}

/**
 * @param {string} root
 * @param {{
 *   arch?: string;
 *   cpuModels?: string[];
 *   hostname?: string;
 *   nodeVersion?: string;
 *   platform?: string;
 *   availableCpuCount?: number;
 *   totalMemory?: number;
 * }} [system]
 */
function createProfileBinding(root, system = {}) {
  const machineDescriptor = {
    arch: system.arch ?? process.arch,
    availableCpuCount: system.availableCpuCount ?? availableParallelism(),
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
 *   system?: { logicalCpuCount?: number; freeMemory?: number; totalMemory?: number };
 * }} [options]
 */
function resolveVitestMaxWorkers(options = {}) {
  const env = options.env ?? process.env;
  const explicit = env.MGT_VITEST_MAX_WORKERS;
  const resourceLimit = resolveWorkerResourceLimit(options.system);
  if (explicit !== undefined && explicit !== "") {
    return parseLocalWorkerCount(explicit, resourceLimit);
  }
  return resolveResourceAwareDefault(options.system);
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
      preferLowerWorkerCountWithinFastestP95: 0.05,
    },
    validated: selection.validated,
    activationEligible: false,
    diagnosticOnlyReason:
      "profiles recommend a worker override; runtime defaults remain resource-aware",
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
 *   resourceLimit?: number;
 *   resourceSafe?: boolean;
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
    resourceUnsafeRuns: runs.filter(
      (run) =>
        run.resourceSafe !== true ||
        !Number.isSafeInteger(run.resourceLimit) ||
        run.workers > Number(run.resourceLimit),
    ).length,
    resourceLimits: uniqueSorted(
      runs.map((run) =>
        Number.isSafeInteger(run.resourceLimit)
          ? String(run.resourceLimit)
          : undefined,
      ),
    ),
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
      summary.resourceUnsafeRuns === 0 &&
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
    .filter((summary) => summary.workers > DEFAULT_WORKERS)
    .filter(
      (summary) =>
        summary.p50Ms <= baseline.p50Ms * 0.9 &&
        summary.p95Ms <= baseline.p95Ms * 0.9,
    );
  const fastest = [...eligible].sort(
    (left, right) => left.p95Ms - right.p95Ms,
  )[0];
  const selected = fastest
    ? [...eligible]
        .filter((summary) => summary.p95Ms <= fastest.p95Ms * 1.05)
        .sort((left, right) => left.workers - right.workers)[0]
    : undefined;
  return selected
    ? {
        validated: true,
        workers: selected.workers,
        reason: "selected worker count clears the 10% p50/p95 rules",
      }
    : {
        validated: true,
        workers: DEFAULT_WORKERS,
        reason: "no candidate safely outperformed the resource-aware baseline",
      };
}

/**
 * @param {{ logicalCpuCount?: number; freeMemory?: number; totalMemory?: number }} [system]
 */
function machineSupportsProfile(system = {}) {
  return resolveWorkerResourceLimit(system) >= MAX_EXPLICIT_WORKERS;
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
  MAX_EXPLICIT_WORKERS,
  MINIMUM_ITERATIONS,
  PROFILE_RELATIVE_PATH,
  buildProfileRecord,
  createProfileBinding,
  isCiEnvironment,
  isValidatedProfile,
  machineSupportsProfile,
  parseLocalWorkerCount,
  resolveResourceAwareDefault,
  resolveVitestMaxWorkers,
  resolveWorkerResourceLimit,
  selectValidatedWorkers,
  stableJson,
};
