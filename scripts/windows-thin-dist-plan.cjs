// @ts-check

const DEFAULT_NVIDIA_COMPUTE_CAPS = "75,80,86,89,90,120";

/**
 * @typedef {{
 *   command: string;
 *   args: string[];
 *   env: NodeJS.ProcessEnv;
 * }} DistributionCommand
 */

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 */
function shouldBuildFluxNvidiaRunners(argv, env) {
  return (
    argv.includes("--with-flux-nvidia") ||
    env.MGT_BUILD_FLUX_NVIDIA_RUNNERS === "1"
  );
}

/**
 * @param {{
 *   nodeCommand: string;
 *   withFluxNvidia: boolean;
 *   env: NodeJS.ProcessEnv;
 * }} options
 * @returns {DistributionCommand[]}
 */
function createWindowsThinDistributionPlan(options) {
  /** @type {DistributionCommand[]} */
  const commands = [];
  if (options.withFluxNvidia) {
    commands.push({
      command: options.nodeCommand,
      args: ["scripts/prepare-flux-klein-runner.cjs"],
      env: {
        MGT_FLUX_KLEIN_COMPUTE_CAPS:
          options.env.MGT_FLUX_KLEIN_COMPUTE_CAPS ??
          DEFAULT_NVIDIA_COMPUTE_CAPS,
        MGT_FORCE_REBUILD_FLUX_RUNNER:
          options.env.MGT_FORCE_REBUILD_FLUX_RUNNER ?? "1",
      },
    });
  }
  commands.push(
    {
      command: options.nodeCommand,
      args: ["scripts/prepare-import-source-runner.cjs"],
      env: {},
    },
    { command: "npm", args: ["run", "build"], env: {} },
    {
      command: options.nodeCommand,
      args: ["scripts/build-windows-installer.cjs"],
      env: {
        MGT_BUNDLE_FLUX_NVIDIA_RUNNERS: options.withFluxNvidia ? "1" : "0",
      },
    },
    {
      command: options.nodeCommand,
      args: ["scripts/verify-packaged-runtime.cjs"],
      env: {},
    },
  );
  return commands;
}

/**
 * @param {string} command
 * @param {string} nodeCommand
 * @param {NodeJS.Platform} platform
 */
function shouldUseDistributionShell(command, nodeCommand, platform) {
  return platform === "win32" && command !== nodeCommand;
}

module.exports = {
  DEFAULT_NVIDIA_COMPUTE_CAPS,
  createWindowsThinDistributionPlan,
  shouldBuildFluxNvidiaRunners,
  shouldUseDistributionShell,
};
