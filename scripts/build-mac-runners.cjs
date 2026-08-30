#!/usr/bin/env node
// @ts-check

const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { patchCandleMetalQMatMul } = require("./patch-candle-metal-qmatmul.cjs");
const {
  assertFluxProtocolSmoke,
  assertMetalCapabilities,
  createMetalRunnerBuildPlan,
} = require("./metal-runner-build-plan.cjs");

const root = join(__dirname, "..");

/**
 * @typedef {{
 *   captureOutput?: boolean;
 *   input?: string;
 * }} RunOptions
 */

/**
 * @typedef {(
 *   command: string,
 *   args: string[],
 *   options?: RunOptions,
 * ) => string} RunCommand
 */

/**
 * @param {{
 *   cwd?: string;
 *   environment?: NodeJS.ProcessEnv;
 * }} [options]
 * @returns {RunCommand}
 */
function createCommandRunner(options = {}) {
  const cwd = options.cwd ?? root;
  const environment = options.environment ?? process.env;
  return (command, args, runOptions = {}) => {
    const result = spawnSync(command, args, {
      cwd,
      env: {
        ...environment,
        CARGO_INCREMENTAL: "0",
        CANDLE_METAL_XCODE: "1",
        LLAMA_CPP_TAG: environment.LLAMA_CPP_TAG || "b-mgt-unused",
      },
      ...(runOptions.captureOutput
        ? {
            encoding: "utf8",
            ...(runOptions.input === undefined
              ? {}
              : { input: runOptions.input }),
          }
        : { stdio: "inherit" }),
      shell: false,
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      const detail =
        typeof result.stderr === "string" ? result.stderr.trim() : "";
      throw new Error(
        `${command} failed with exit code ${result.status ?? "null"}${
          detail ? `: ${detail}` : ""
        }`,
      );
    }
    return typeof result.stdout === "string" ? result.stdout.trim() : "";
  };
}

/**
 * @param {ReturnType<typeof createMetalRunnerBuildPlan>} plan
 * @param {RunCommand} run
 */
function executeMetalRunnerBuildPlan(plan, run) {
  for (const entry of plan) {
    run(entry.build.command, entry.build.args);
    const capabilities = parseRunnerJson(
      run(entry.capabilities.command, entry.capabilities.args, {
        captureOutput: true,
      }),
      `${entry.id} capabilities`,
    );
    assertMetalCapabilities(capabilities, entry);
    if (entry.protocolSmoke) {
      const smoke = parseRunnerJson(
        run(entry.protocolSmoke.command, entry.protocolSmoke.args, {
          captureOutput: true,
          input: entry.protocolSmoke.input,
        }),
        `${entry.id} protocol smoke`,
      );
      assertFluxProtocolSmoke(smoke, entry);
    }
  }
}

/** @param {string} output @param {string} label @returns {unknown} */
function parseRunnerJson(output, label) {
  if (!output.trim()) {
    throw new Error(`${label} did not produce JSON output`);
  }
  try {
    return JSON.parse(output);
  } catch (cause) {
    throw new Error(`${label} produced invalid JSON`, { cause });
  }
}

function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Metal runner builds require an Apple Silicon Mac.");
  }
  const plan = createMetalRunnerBuildPlan(root);
  const fluxManifest = plan.find(
    (entry) => entry.id === "mgt-flux-klein",
  )?.manifestPath;
  if (!fluxManifest) {
    throw new Error("Flux Metal build plan is missing");
  }
  patchCandleMetalQMatMul({ cwd: root, manifestPath: fluxManifest });
  const run = createCommandRunner();
  executeMetalRunnerBuildPlan(plan, run);
  run(process.execPath, [
    "scripts/prepare-import-source-runner.cjs",
    "--target",
    "aarch64-apple-darwin",
    "--no-copy",
  ]);
}

if (require.main === module) {
  main();
}

module.exports = {
  createCommandRunner,
  executeMetalRunnerBuildPlan,
  parseRunnerJson,
};
