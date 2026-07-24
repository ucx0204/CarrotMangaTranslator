/**
 * @typedef {{ line(text: string): void; raw(text: string): void; close(): void }} BuildLogger
 * @typedef {{ sdkVersion?: string; pathEntries: string[]; includePaths: string[]; libPaths: string[] }} NativeBuildEnv
 * @typedef {{ pythonExe: string; packageDir: string; env: NodeJS.ProcessEnv; logger: BuildLogger }} VerifyRuntimeOptions
 * @typedef {{ runtimeDir: string; gpuTargets: string; nativeBuildEnv: NativeBuildEnv; logger: BuildLogger }} RuntimeManifestOptions
 * @typedef {{ runtimeDir: string; outputPath: string; logger: BuildLogger }} RuntimeZipOptions
 */
const { existsSync, rmSync, statSync } = require("node:fs");
const { writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const {
  manifestFile,
  pythonVersion,
  rocmVersion,
  workerFile,
} = require("./config.cjs");
const { formatBytes, readGitRevision } = require("./build-utils.cjs");
const { run } = require("./process-utils.cjs");
const { isDirectory } = require("./windows-native-tools.cjs");

/**
 * @param {VerifyRuntimeOptions} options
 * @returns {Promise<void>}
 */
async function verifyRuntime({ pythonExe, packageDir, env, logger }) {
  const script = [
    "import importlib",
    "for name in ['stable_diffusion_cpp','PIL','huggingface_hub']:",
    "    importlib.import_module(name)",
    "print('ok')",
  ].join("\n");
  await run(pythonExe, ["-c", script], { env, logger });
  await run(pythonExe, ["-m", "pip", "show", "stable-diffusion-cpp-python"], {
    env,
    logger,
  });
  if (!isDirectory(join(packageDir, "stable_diffusion_cpp"))) {
    throw new Error(
      `stable_diffusion_cpp package is missing from ${packageDir}`,
    );
  }
}

/**
 * @param {RuntimeManifestOptions} options
 * @returns {Promise<void>}
 */
async function writeRuntimeManifest({
  runtimeDir,
  gpuTargets,
  nativeBuildEnv,
  logger,
}) {
  const manifest = {
    schemaVersion: 1,
    kind: "mgt-flux-rocm-prebuilt-runtime",
    backend: "python-rocm",
    runtime: "stable-diffusion-cpp-python",
    rocmVersion,
    pythonVersion,
    platform: "win32",
    arch: "x64",
    packageDir: "p",
    pythonPath: `bootstrap-python/python-${pythonVersion}/python.exe`,
    worker: workerFile,
    gpuTargets: gpuTargets ? gpuTargets.split(";") : [],
    windowsSdkVersion: nativeBuildEnv.sdkVersion || null,
    createdAt: new Date().toISOString(),
    gitRevision: readGitRevision(),
  };
  await writeFile(
    join(runtimeDir, manifestFile),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  logger.line(`manifest written: ${join(runtimeDir, manifestFile)}`);
}

/**
 * @param {RuntimeZipOptions} options
 * @returns {Promise<void>}
 */
async function createRuntimeZip({ runtimeDir, outputPath, logger }) {
  logger.line(`creating zip with Windows bsdtar: ${outputPath}`);
  if (existsSync(outputPath)) {
    logger.line(
      `removing existing zip: ${outputPath} (${formatBytes(statSync(outputPath).size)})`,
    );
    rmSync(outputPath, { force: true });
  }
  await run("tar.exe", ["-a", "-cf", outputPath, "-C", runtimeDir, "."], {
    env: process.env,
    logger,
    cwd: runtimeDir,
  });
  logger.line(
    `zip created: ${outputPath} (${formatBytes(statSync(outputPath).size)})`,
  );
}

module.exports = { createRuntimeZip, verifyRuntime, writeRuntimeManifest };
