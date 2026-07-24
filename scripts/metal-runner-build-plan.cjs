// @ts-check

const { join } = require("node:path");

const METAL_TARGET = "aarch64-apple-darwin";

/**
 * @typedef {{
 *   protocol_version: number;
 *   runner: string;
 *   backend: string;
 *   metal_device?: boolean;
 *   models?: string[];
 *   request?: string;
 *   ok?: boolean;
 * }} RunnerContract
 * @typedef {{
 *   id: string;
 *   manifestPath: string;
 *   binaryPath: string;
 *   build: { command: "cargo"; args: string[] };
 *   capabilities: { command: string; args: ["--capabilities"] };
 *   expectedModels: string[];
 *   protocolSmoke?: {
 *     command: string;
 *     args: ["--protocol-smoke"];
 *     input: string;
 *   };
 * }} MetalRunnerBuild
 */

/**
 * @param {string} root
 * @param {string} [target]
 * @returns {MetalRunnerBuild[]}
 */
function createMetalRunnerBuildPlan(root, target = METAL_TARGET) {
  return [
    createRunnerBuild({
      root,
      target,
      directory: "mgt-koharu-inpaint-runner",
      binary: "mgt-koharu-inpaint-runner",
      models: ["lama-manga", "aot-inpainting"],
      protocolSmoke: false,
    }),
    createRunnerBuild({
      root,
      target,
      directory: "mgt-flux-klein-runner",
      binary: "mgt-flux-klein",
      models: ["flux-klein"],
      protocolSmoke: true,
    }),
  ];
}

/**
 * @param {{
 *   root: string;
 *   target: string;
 *   directory: string;
 *   binary: string;
 *   models: string[];
 *   protocolSmoke: boolean;
 * }} options
 * @returns {MetalRunnerBuild}
 */
function createRunnerBuild(options) {
  const manifestPath = join(
    options.root,
    "tools",
    options.directory,
    "Cargo.toml",
  );
  const binaryPath = join(
    options.root,
    "tools",
    options.directory,
    "target",
    options.target,
    "release",
    options.binary,
  );
  return {
    id: options.binary,
    manifestPath,
    binaryPath,
    build: {
      command: "cargo",
      args: [
        "build",
        "--manifest-path",
        manifestPath,
        "--locked",
        "--release",
        "--target",
        options.target,
        "--no-default-features",
        "--features",
        "metal",
      ],
    },
    capabilities: {
      command: binaryPath,
      args: ["--capabilities"],
    },
    expectedModels: options.models,
    ...(options.protocolSmoke
      ? {
          protocolSmoke: {
            command: binaryPath,
            args: ["--protocol-smoke"],
            input: `${JSON.stringify({ type: "shutdown" })}\n`,
          },
        }
      : {}),
  };
}

/**
 * @param {unknown} value
 * @param {MetalRunnerBuild} build
 * @returns {RunnerContract}
 */
function assertMetalCapabilities(value, build) {
  const contract = requireRunnerContract(value);
  if (
    contract.protocol_version !== 1 ||
    contract.runner !== build.id ||
    contract.backend !== "metal-native" ||
    contract.metal_device !== true ||
    JSON.stringify(contract.models) !== JSON.stringify(build.expectedModels)
  ) {
    throw new Error(`Invalid Metal capability contract for ${build.id}`);
  }
  return contract;
}

/**
 * @param {unknown} value
 * @param {MetalRunnerBuild} build
 * @returns {RunnerContract}
 */
function assertFluxProtocolSmoke(value, build) {
  const contract = requireRunnerContract(value);
  if (
    build.id !== "mgt-flux-klein" ||
    contract.protocol_version !== 1 ||
    contract.runner !== build.id ||
    contract.backend !== "metal-native" ||
    contract.request !== "shutdown" ||
    contract.ok !== true
  ) {
    throw new Error("Invalid Flux Metal protocol smoke contract");
  }
  return contract;
}

/** @param {unknown} value @returns {RunnerContract} */
function requireRunnerContract(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runner contract must be a JSON object");
  }
  return /** @type {RunnerContract} */ (value);
}

module.exports = {
  METAL_TARGET,
  assertFluxProtocolSmoke,
  assertMetalCapabilities,
  createMetalRunnerBuildPlan,
};
