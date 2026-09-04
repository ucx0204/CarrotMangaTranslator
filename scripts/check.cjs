const { createHash } = require("node:crypto");
const {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { availableParallelism, freemem } = require("node:os");
const { dirname, join, relative } = require("node:path");
const {
  calculateCriticalPathMs,
  monotonicMilliseconds,
  readStageMetadata,
  resolveCheckParallelism,
  runStage,
  runStageGraph,
  validateStages,
} = require("./check-stage-runner.cjs");
const {
  digestTestReport,
  extractTestCounts,
} = require("./soak-vitest-workers.cjs");
const {
  resolveVitestMaxWorkers,
  stableJson,
} = require("./vitest-worker-profile.cjs");

const root = join(__dirname, "..");
const timingPath = join(root, ".tmp", "check-timings.json");
const resultDirectory = join(root, ".tmp", "check-results");
const vitestResultPath = join(resultDirectory, "vitest.json");
const coverageSummaryPath = join(root, "coverage", "coverage-summary.json");

/**
 * @typedef {"parallel" | "exclusive"} CheckExecutionClass
 * @typedef {{
 *   id: string;
 *   command: string;
 *   args: string[];
 *   dependsOn: string[];
 *   executionClass: CheckExecutionClass;
 * }} CheckStage
 * @typedef {import("./check-stage-runner.cjs").CheckStageResult} CheckStageResult
 */

/**
 * @param {string} id
 * @param {string[]} args
 * @param {{ dependsOn?: string[]; executionClass?: CheckExecutionClass }} [options]
 * @returns {CheckStage}
 */
function nodeStage(id, args, options = {}) {
  return {
    id,
    command: process.execPath,
    args,
    dependsOn: options.dependsOn ?? [],
    executionClass: options.executionClass ?? "parallel",
  };
}

/** @param {string} packageName @param {...string} parts */
function nodeBin(packageName, ...parts) {
  return join(root, "node_modules", packageName, ...parts);
}

/** @param {string} privateWorkspaceId @param {boolean} cold @returns {CheckStage[]} */
function createPreflightStages(privateWorkspaceId, cold) {
  /** @param {string} id @param {...string} args */
  const stage = (id, ...args) =>
    nodeStage(id, args, { dependsOn: [privateWorkspaceId] });
  return [
    stage(
      "typecheck",
      nodeBin("typescript", "bin", "tsc"),
      "-p",
      "tsconfig.typecheck.json",
      ...(cold ? ["--incremental", "false"] : []),
    ),
    // The Node/CommonJS Electron project must pass before --noCheck emit.
    stage(
      "typecheck-electron",
      nodeBin("typescript", "bin", "tsc"),
      "-p",
      "tsconfig.electron-typecheck.json",
      ...(cold ? ["--incremental", "false"] : []),
    ),
    stage(
      "typecheck-js",
      nodeBin("typescript", "bin", "tsc"),
      "-p",
      "tsconfig.checkjs.json",
      ...(cold ? ["--incremental", "false"] : []),
    ),
    stage("format", join(__dirname, "run-prettier.cjs"), "--check"),
    stage(
      "lint",
      nodeBin("eslint", "bin", "eslint.js"),
      ".",
      "--max-warnings",
      "0",
      ...(cold
        ? []
        : [
            "--cache",
            "--cache-strategy",
            "content",
            "--cache-location",
            ".tmp/check-cache/eslint",
          ]),
    ),
    stage("error-handling", join(__dirname, "check-error-handling.cjs")),
    stage(
      "test-mock-boundaries",
      join(__dirname, "check-test-mock-boundaries.cjs"),
    ),
    stage("architecture", join(__dirname, "check-architecture.cjs")),
    stage(
      "maintainability-policy",
      join(__dirname, "check-maintainability-policy.cjs"),
    ),
    stage("duplicates", join(__dirname, "check-duplicates.cjs")),
    stage("reexports", join(__dirname, "check-reexport-boundaries.cjs")),
    stage("generated", join(__dirname, "check-generated-clean.cjs")),
    stage("css-structure", join(__dirname, "check-css-structure.cjs")),
    stage(
      "script-entrypoints",
      join(__dirname, "check-script-entrypoints.cjs"),
    ),
    stage(
      "deadcode",
      nodeBin("knip", "bin", "knip.js"),
      "--config",
      "knip.config.cjs",
      "--files",
      "--dependencies",
      "--no-config-hints",
    ),
    stage(
      "deadcode-exports",
      nodeBin("knip", "bin", "knip.js"),
      "--config",
      "knip.exports.json",
      "--exports",
      "--no-config-hints",
    ),
    stage("prepare-electron", nodeBin("electron", "install.js")),
    stage(
      "prepare-import-source-runner",
      join(__dirname, "prepare-import-source-runner.cjs"),
      "--no-copy",
    ),
  ];
}

/** @param {string} buildId @returns {CheckStage[]} */
function createPostBuildStages(buildId) {
  /** @param {string} id @param {string} script */
  const stage = (id, script) =>
    nodeStage(id, [join(__dirname, script)], { dependsOn: [buildId] });
  return [
    stage("page-artwork-parity", "run-page-artwork-pixel-parity.cjs"),
    stage("image-protocol-smoke", "run-image-protocol-smoke.cjs"),
    stage("renderer-bundle", "check-renderer-bundle-boundary.cjs"),
    stage("preload-bundle", "check-preload-bundle-boundary.cjs"),
  ];
}

/** @param {{ cold?: boolean }} [options] @returns {CheckStage[]} */
function createStages(options = {}) {
  const privateWorkspace = nodeStage(
    "private-workspace",
    [join(__dirname, "check-private-workspace-files.cjs")],
    { executionClass: "exclusive" },
  );
  const preflight = createPreflightStages(
    privateWorkspace.id,
    options.cold === true,
  );
  const testCoverage = nodeStage(
    "test-coverage",
    [
      nodeBin("vitest", "vitest.mjs"),
      "run",
      "--coverage",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${relative(root, vitestResultPath)}`,
    ],
    {
      dependsOn: preflight.map((stage) => stage.id),
      executionClass: "exclusive",
    },
  );
  const coverageSeal = nodeStage(
    "production-cleanup-coverage",
    [join(__dirname, "check-production-cleanup-coverage.cjs")],
    { dependsOn: [testCoverage.id], executionClass: "exclusive" },
  );
  const build = nodeStage(
    "build",
    [
      join(__dirname, "build.cjs"),
      "--skip-typecheck",
      ...(options.cold ? [] : ["--reuse-verified-outputs"]),
    ],
    { dependsOn: [coverageSeal.id], executionClass: "exclusive" },
  );
  return [
    privateWorkspace,
    ...preflight,
    testCoverage,
    coverageSeal,
    build,
    ...createPostBuildStages(build.id),
  ];
}

/** @param {number} milliseconds */
function formatDuration(milliseconds) {
  return `${(milliseconds / 1000).toFixed(2)}s`;
}

/** @param {CheckStageResult[]} results */
function printResultSummary(results) {
  console.log("\n[check] stage summary");
  for (const result of results) {
    const cache =
      result.cacheHit === true
        ? " cache=hit"
        : result.cacheHit === false
          ? " cache=miss"
          : "";
    console.log(
      `- ${result.id}: ${result.status} ${formatDuration(result.durationMs)}${cache}`,
    );
  }
  replayFailureLogs(results);
}

/** @param {CheckStageResult[]} results */
function replayFailureLogs(results) {
  for (const result of results.filter((entry) => entry.status === "failed")) {
    console.error(`\n[check] failure log: ${result.logPath || "unavailable"}`);
    if (result.logPath) {
      try {
        process.stderr.write(readFileSync(join(root, result.logPath), "utf8"));
      } catch (error) {
        console.error(`[check] could not replay failure log: ${String(error)}`);
      }
    } else if (result.metadata?.runnerError) {
      console.error(String(result.metadata.runnerError));
    }
  }
}

function readTestRunSummary() {
  try {
    const testReport = JSON.parse(readFileSync(vitestResultPath, "utf8"));
    const coverage = JSON.parse(readFileSync(coverageSummaryPath, "utf8"));
    return {
      counts: extractTestCounts(testReport),
      testDigest: digestTestReport(testReport),
      coverageDigest: createHash("sha256")
        .update(stableJson(coverage))
        .digest("hex"),
      coverage: coverage.total,
    };
  } catch (error) {
    return { unavailableReason: String(error) };
  }
}

/** @param {object} report */
function writeTimingReport(report) {
  try {
    mkdirSync(dirname(timingPath), { recursive: true });
    writeFileSync(timingPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`[check] timing report: ${timingPath}`);
  } catch (error) {
    console.warn(`[check] could not write timing report: ${String(error)}`);
  }
}

/** @param {CheckStageResult[]} results @param {number} totalMs */
function writeGitHubSummary(results, totalMs) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const rows = results.map(
    (result) =>
      `| ${result.id} | ${result.status} | ${formatDuration(result.queuedMs)} | ${formatDuration(result.durationMs)} |`,
  );
  const markdown = [
    "## npm run check timings",
    "",
    "| Stage | Status | Queue | Duration |",
    "| --- | --- | ---: | ---: |",
    ...rows,
    `| **Wall time** |  |  | **${formatDuration(totalMs)}** |`,
    "",
  ].join("\n");
  try {
    appendFileSync(summaryPath, markdown, "utf8");
  } catch (error) {
    console.warn(`[check] could not append GitHub summary: ${String(error)}`);
  }
}

function printHelp() {
  console.log("Runs the complete repository check DAG:");
  for (const stage of createStages()) {
    console.log(
      `- ${stage.id} [${stage.executionClass}] <- ${stage.dependsOn.join(", ") || "root"}`,
    );
  }
  console.log("\n--cold bypasses every reusable check acceleration cache.");
}

function clearStaleTestReports() {
  mkdirSync(resultDirectory, { recursive: true });
  for (const filePath of [vitestResultPath, coverageSummaryPath]) {
    if (existsSync(filePath)) unlinkSync(filePath);
  }
}

/**
 * @param {CheckStage[]} stages
 * @param {CheckStageResult[]} results
 * @param {{
 *   startedAt: string;
 *   totalMs: number;
 *   failed: CheckStageResult | undefined;
 *   maxParallel: number;
 *   vitestWorkers: number;
 *   cold: boolean;
 * }} context
 */
function createTimingReport(stages, results, context) {
  return {
    schemaVersion: 2,
    startedAt: context.startedAt,
    completedAt: new Date().toISOString(),
    status: context.failed ? "failed" : "passed",
    wallMs: Math.round(context.totalMs),
    totalMs: Math.round(context.totalMs),
    criticalPathMs: calculateCriticalPathMs(stages, results),
    scheduler: {
      maxParallel: context.maxParallel,
      availableCpuCount: availableParallelism(),
      freeMemoryBytesAtCompletion: freemem(),
    },
    vitestWorkers: context.vitestWorkers,
    cold: context.cold,
    testRun: readTestRunSummary(),
    stages: results,
  };
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) return printHelp();
  clearStaleTestReports();
  const stages = validateStages(createStages({ cold: parsed.cold }));
  const maxParallel = resolveCheckParallelism();
  const vitestWorkers = resolveVitestMaxWorkers();
  const startedAt = new Date().toISOString();
  const started = monotonicMilliseconds();
  console.log(
    `[check] ${stages.length} gates, static parallelism=${maxParallel}, vitest workers=${vitestWorkers}${parsed.cold ? ", cold" : ""}`,
  );
  const results = await runStageGraph(stages, {
    env: { ...process.env, MGT_CHECK_COLD: parsed.cold ? "1" : "0" },
    maxParallel,
  });
  const totalMs = monotonicMilliseconds() - started;
  const failed = results.find((result) => result.status === "failed");
  printResultSummary(results);
  const report = createTimingReport(stages, results, {
    startedAt,
    totalMs,
    failed,
    maxParallel,
    vitestWorkers,
    cold: parsed.cold,
  });
  writeTimingReport(report);
  writeGitHubSummary(results, totalMs);
  console.log(`\n[check] ${report.status} in ${formatDuration(totalMs)}`);
  if (failed) process.exitCode = failed.exitCode || 1;
}

/** @param {string[]} args */
function parseArguments(args) {
  if (args.length === 0) return { cold: false, help: false };
  if (args.length === 1 && args[0] === "--cold") {
    return { cold: true, help: false };
  }
  if (args.length === 1 && args[0] === "--help") {
    return { cold: false, help: true };
  }
  throw new Error(`Unsupported check arguments: ${args.join(" ")}`);
}

module.exports = {
  calculateCriticalPathMs,
  createStages,
  formatDuration,
  nodeStage,
  readStageMetadata,
  resolveCheckParallelism,
  runStage,
  runStageGraph,
  validateStages,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
