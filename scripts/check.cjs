const { spawnSync } = require("node:child_process");
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const {
  createCheckBuildPlan,
  promoteCheckBuild,
  restoreCheckBuild,
} = require("./check-build-cache.cjs");
const { isCiEnvironment } = require("./vitest-worker-profile.cjs");

const root = join(__dirname, "..");
const timingPath = join(root, ".tmp", "check-timings.json");

/**
 * @typedef {{ id: string; command: string; args: string[] }} CheckStage
 * @typedef {{
 *   id: string;
 *   command: string;
 *   durationMs: number;
 *   status: "passed" | "failed";
 *   exitCode: number;
 * }} CheckStageResult
 */

/** @param {string} id @param {...string} args */
function nodeStage(id, ...args) {
  return { id, command: process.execPath, args };
}

/** @param {string} packageName @param {...string} parts */
function nodeBin(packageName, ...parts) {
  return join(root, "node_modules", packageName, ...parts);
}

/** @returns {CheckStage[]} */
function createStages() {
  return [
    nodeStage(
      "typecheck",
      nodeBin("typescript", "bin", "tsc"),
      "-p",
      "tsconfig.typecheck.json",
    ),
    // The renderer-wide typecheck uses Bundler resolution. Seal the distinct
    // Node/CommonJS Electron project before its later --noCheck emit as well.
    nodeStage(
      "typecheck-electron",
      nodeBin("typescript", "bin", "tsc"),
      "-p",
      "tsconfig.electron-typecheck.json",
    ),
    nodeStage(
      "typecheck-js",
      nodeBin("typescript", "bin", "tsc"),
      "-p",
      "tsconfig.checkjs.json",
    ),
    nodeStage("format", join(__dirname, "run-prettier.cjs"), "--check"),
    nodeStage(
      "lint",
      nodeBin("eslint", "bin", "eslint.js"),
      ".",
      "--max-warnings",
      "0",
      "--cache",
      "--cache-strategy",
      "content",
      "--cache-location",
      ".tmp/check-cache/eslint",
    ),
    nodeStage("error-handling", join(__dirname, "check-error-handling.cjs")),
    nodeStage(
      "test-mock-boundaries",
      join(__dirname, "check-test-mock-boundaries.cjs"),
    ),
    nodeStage("architecture", join(__dirname, "check-architecture.cjs")),
    nodeStage("reexports", join(__dirname, "check-reexport-boundaries.cjs")),
    nodeStage("generated", join(__dirname, "check-generated-clean.cjs")),
    nodeStage("css-structure", join(__dirname, "check-css-structure.cjs")),
    nodeStage(
      "script-entrypoints",
      join(__dirname, "check-script-entrypoints.cjs"),
    ),
    nodeStage(
      "deadcode",
      nodeBin("knip", "bin", "knip.js"),
      "--config",
      "knip.config.cjs",
      "--files",
      "--dependencies",
      "--no-config-hints",
    ),
    nodeStage(
      "deadcode-exports",
      nodeBin("knip", "bin", "knip.js"),
      "--config",
      "knip.exports.json",
      "--exports",
      "--no-config-hints",
    ),
    nodeStage("prepare-electron", nodeBin("electron", "install.js")),
    nodeStage(
      "test-coverage",
      nodeBin("vitest", "vitest.mjs"),
      "run",
      "--coverage",
    ),
    nodeStage("build", join(__dirname, "build.cjs"), "--skip-typecheck"),
    nodeStage(
      "page-artwork-parity",
      join(__dirname, "run-page-artwork-pixel-parity.cjs"),
    ),
    nodeStage(
      "image-protocol-smoke",
      join(__dirname, "run-image-protocol-smoke.cjs"),
    ),
    nodeStage(
      "renderer-bundle",
      join(__dirname, "check-renderer-bundle-boundary.cjs"),
    ),
    nodeStage(
      "preload-bundle",
      join(__dirname, "check-preload-bundle-boundary.cjs"),
    ),
  ];
}

/** @param {number} milliseconds */
function formatDuration(milliseconds) {
  return `${(milliseconds / 1000).toFixed(2)}s`;
}

function monotonicMilliseconds() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

/** @param {CheckStage} stage @returns {CheckStageResult} */
function runStage(stage) {
  console.log(`\n[check] ${stage.id}`);
  const started = monotonicMilliseconds();
  const result = spawnSync(stage.command, stage.args, {
    cwd: root,
    env: process.env,
    shell: false,
    stdio: "inherit",
  });
  const durationMs = monotonicMilliseconds() - started;
  const exitCode = result.status ?? 1;
  if (result.error) {
    console.error(result.error);
  }
  if (result.signal) {
    console.error(`[check] ${stage.id} terminated by ${result.signal}`);
  }
  const status = exitCode === 0 ? "passed" : "failed";
  console.log(`[check] ${stage.id} ${status} in ${formatDuration(durationMs)}`);
  return {
    id: stage.id,
    command: [stage.command, ...stage.args].join(" "),
    durationMs: Math.round(durationMs),
    status,
    exitCode,
  };
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
      `| ${result.id} | ${result.status} | ${formatDuration(result.durationMs)} |`,
  );
  const markdown = [
    "## npm run check timings",
    "",
    "| Stage | Status | Duration |",
    "| --- | --- | ---: |",
    ...rows,
    `| **Total** |  | **${formatDuration(totalMs)}** |`,
    "",
  ].join("\n");
  try {
    appendFileSync(summaryPath, markdown, "utf8");
  } catch (error) {
    console.warn(`[check] could not append GitHub summary: ${String(error)}`);
  }
}

function printHelp() {
  console.log("Runs the complete repository check gate in this order:");
  for (const stage of createStages()) {
    console.log(`- ${stage.id}`);
  }
  console.log(
    "\n--cold bypasses the local build artifact cache (CI always bypasses it).",
  );
}

/** @param {ReturnType<typeof createCheckBuildPlan>} plan */
function restoreCheckBuildSafely(plan) {
  try {
    return restoreCheckBuild(plan);
  } catch (error) {
    // A cache file may disappear or become unreadable after inspection.
    // Treat every restore-time race as a miss and regenerate all outputs.
    return {
      restored: false,
      reason: `restore failed safely: ${String(error)}`,
    };
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    printHelp();
    return;
  }
  const cold = args.length === 1 && args[0] === "--cold";
  if (args.length > 0 && !cold) {
    console.error(`Unsupported check arguments: ${args.join(" ")}`);
    process.exitCode = 2;
    return;
  }

  const startedAt = new Date().toISOString();
  const started = monotonicMilliseconds();
  /** @type {CheckStageResult[]} */
  const results = [];
  const cacheEnabled = !cold && !isCiEnvironment(process.env);
  let buildPlan;
  let shouldPromoteBuild = false;
  for (const stage of createStages()) {
    /** @type {CheckStageResult} */
    let result;
    if (
      stage.id === "build" &&
      cacheEnabled &&
      buildCacheOptedIn(process.env)
    ) {
      buildPlan = createCheckBuildPlan(root);
      const started = monotonicMilliseconds();
      const restored = restoreCheckBuildSafely(buildPlan);
      if (restored.restored) {
        const durationMs = monotonicMilliseconds() - started;
        console.log(`\n[check] build\n[check-cache] ${restored.reason}`);
        result = {
          id: "build",
          command: "[content-addressed cache restore]",
          durationMs: Math.round(durationMs),
          status: "passed",
          exitCode: 0,
        };
      } else {
        console.log(`[check-cache] miss: ${restored.reason}`);
        result = runStage(stage);
        shouldPromoteBuild = result.status === "passed";
      }
    } else {
      result = runStage(stage);
    }
    results.push(result);
    if (result.status === "failed") break;
  }
  const failed = results.find((result) => result.status === "failed");
  if (!failed && shouldPromoteBuild && buildPlan) {
    try {
      const promoted = promoteCheckBuild(buildPlan);
      console.log(`[check-cache] ${promoted.reason}`);
    } catch (error) {
      console.warn(`[check-cache] could not promote build: ${String(error)}`);
    }
  }
  // Include fingerprinting, restore verification, and first-run promotion in
  // the end-to-end number used to decide whether the opt-in cache is worthwhile.
  const totalMs = monotonicMilliseconds() - started;
  const report = {
    schemaVersion: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    status: failed ? "failed" : "passed",
    totalMs: Math.round(totalMs),
    stages: results,
  };
  writeTimingReport(report);
  writeGitHubSummary(results, totalMs);
  console.log(`\n[check] ${report.status} in ${formatDuration(totalMs)}`);
  if (failed) process.exitCode = failed.exitCode || 1;
}

/** @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env */
function buildCacheOptedIn(env) {
  return env.MGT_CHECK_BUILD_CACHE === "1";
}

module.exports = {
  formatDuration,
  createStages,
  buildCacheOptedIn,
  nodeStage,
  runStage,
};

if (require.main === module) {
  main();
}
