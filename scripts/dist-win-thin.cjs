#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const {
  createWindowsThinDistributionPlan,
  shouldBuildFluxNvidiaRunners,
  shouldUseDistributionShell,
} = require("./windows-thin-dist-plan.cjs");

const withFluxNvidia = shouldBuildFluxNvidiaRunners(process.argv, process.env);

/**
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [extraEnv]
 */
function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: shouldUseDistributionShell(
      command,
      process.execPath,
      process.platform,
    ),
    env: {
      ...process.env,
      MGT_THIN_INSTALLER: "1",
      MGT_ALLOW_MISSING_FLUX_RUNNER: "1",
      ...extraEnv,
    },
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const distributionPlan = createWindowsThinDistributionPlan({
  nodeCommand: process.execPath,
  withFluxNvidia,
  env: process.env,
});
for (const invocation of distributionPlan) {
  run(invocation.command, invocation.args, invocation.env);
}
