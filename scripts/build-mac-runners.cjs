#!/usr/bin/env node
// @ts-check

const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const target = "aarch64-apple-darwin";

/** @param {string} command @param {string[]} args */
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: {
      ...process.env,
      CARGO_INCREMENTAL: "0",
      CANDLE_METAL_XCODE: "1",
      LLAMA_CPP_TAG: process.env.LLAMA_CPP_TAG || "b-mgt-unused",
    },
    stdio: "inherit",
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with exit code ${result.status ?? "null"}`,
    );
  }
}

/** @param {string} manifestPath */
function buildMetalRunner(manifestPath) {
  run("cargo", [
    "build",
    "--manifest-path",
    manifestPath,
    "--locked",
    "--release",
    "--target",
    target,
    "--no-default-features",
    "--features",
    "metal",
  ]);
}

function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Metal runner builds require an Apple Silicon Mac.");
  }
  const koharuManifest = join(
    root,
    "tools",
    "mgt-koharu-inpaint-runner",
    "Cargo.toml",
  );
  buildMetalRunner(koharuManifest);

  const fluxManifest = join(
    root,
    "tools",
    "mgt-flux-klein-runner",
    "Cargo.toml",
  );
  if (!existsSync(fluxManifest)) {
    throw new Error(`Missing Flux Metal runner manifest: ${fluxManifest}`);
  }
  if (!/^metal\s*=/m.test(readFileSync(fluxManifest, "utf8"))) {
    throw new Error(
      `Flux runner does not declare its Metal feature: ${fluxManifest}`,
    );
  }
  buildMetalRunner(fluxManifest);
}

main();
