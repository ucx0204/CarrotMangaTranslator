#!/usr/bin/env node
const { spawnSync } = require("node:child_process");

const electronBuilderCli = require.resolve("electron-builder/cli");
const withFluxNvidia =
  process.argv.includes("--with-flux-nvidia") ||
  process.env.MGT_BUILD_FLUX_NVIDIA_RUNNERS === "1";

/**
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [extraEnv]
 */
function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32" && command !== process.execPath,
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

if (withFluxNvidia) {
  run(process.execPath, ["scripts/prepare-flux-klein-runner.cjs"], {
    MGT_FLUX_KLEIN_COMPUTE_CAPS:
      process.env.MGT_FLUX_KLEIN_COMPUTE_CAPS || "75,80,86,89,90,120",
    MGT_FORCE_REBUILD_FLUX_RUNNER:
      process.env.MGT_FORCE_REBUILD_FLUX_RUNNER || "1",
  });
}

run("npm", ["run", "build"]);
run(
  process.execPath,
  [
    electronBuilderCli,
    "--config",
    "electron-builder.config.cjs",
    "--win",
    "nsis",
    "--x64",
    "--publish",
    "never",
  ],
  {
    MGT_BUNDLE_FLUX_NVIDIA_RUNNERS: withFluxNvidia ? "1" : "0",
  },
);
