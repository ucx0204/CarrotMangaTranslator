/**
 * @typedef {{ [key: string]: string | boolean | undefined; out?: string; force?: boolean; "work-dir"?: string; "runtime-dir"?: string; "keep-work"?: boolean; "gpu-targets"?: string }} BuildArgs
 * @typedef {{ line(text: string): void; raw(text: string): void; close(): void }} BuildLogger
 * @typedef {{ sdkVersion?: string; pathEntries: string[]; includePaths: string[]; libPaths: string[] }} NativeBuildEnv
 * @typedef {{ args: BuildArgs; outputPath: string; workDir: string; runtimeDir: string; downloadsDir: string; logsDir: string; logPath: string; envPath: string; keepWork: boolean; force: boolean; logger: BuildLogger }} BuildContext
 * @typedef {{ pythonExe: string; packageDir: string; installEnv: NodeJS.ProcessEnv; nativeBuildEnv: NativeBuildEnv; gpuTargets: string }} PreparedRuntime
 */
const { existsSync, statSync } = require("node:fs");
const { copyFile, mkdir, rm, writeFile } = require("node:fs/promises");
const { basename, dirname, join, resolve } = require("node:path");
const {
  buildPackages,
  fluxPackages,
  outputFileName,
  pythonVersion,
  releasePartBytes,
  rocmPackageUrls,
  rocmVersion,
  rootDir,
  workerFile,
} = require("./config.cjs");
const {
  resolveGpuTargets,
  sha256File,
  snapshotEnvironment,
} = require("./build-utils.cjs");
const { run } = require("./process-utils.cjs");
const {
  buildPythonPackageInstallEnv,
  buildRuntimeEnv,
  createRuntimeZip,
  initializeRocmSdk,
  prepareEmbeddedPython,
  splitRuntimeArchiveForRelease,
  verifyRuntime,
  writeRuntimeManifest,
} = require("./runtime-builder.cjs");
const {
  createLogger,
  ensureBuildDiskSpace,
  formatOptionalBytes,
  getPathFreeBytes,
  parseArgs,
  resolveDefaultWorkDir,
} = require("./workspace.cjs");
const {
  formatWindowsNativeBuildToolsMissingMessage,
  isFile,
  resolveWindowsNativeBuildEnv,
} = require("./windows-native-tools.cjs");

/**
 * @param {unknown} error
 * @returns {string}
 */
function formatUnknownError(error) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

/**
 * @returns {Promise<void>}
 */
async function main() {
  const context = createBuildContext(process.argv.slice(2));
  try {
    await prepareBuildWorkspace(context);
    const prepared = await buildRuntime(context);
    await packageRuntime(context, prepared);
  } catch (error) {
    context.logger.line("");
    context.logger.line("BUILD FAILED");
    context.logger.line(formatUnknownError(error));
    context.logger.line(`Log file: ${context.logPath}`);
    throw error;
  } finally {
    context.logger.close();
    if (!context.keepWork && !process.exitCode) {
      // Keep work dir by default during early runtime work; deleting it makes build failures hard to inspect.
      // Users can remove .tmp/flux-rocm-runtime-build after uploading the ZIP.
    }
  }
}

/** @param {string[]} argv @returns {BuildContext} */
function createBuildContext(argv) {
  const args = parseArgs(argv);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = resolve(
    args.out || join(rootDir, "dist", "runtime", outputFileName),
  );
  const workDir = resolve(
    args["work-dir"] || resolveDefaultWorkDir(stamp, outputPath),
  );
  const runtimeDir = resolve(args["runtime-dir"] || join(workDir, "runtime"));
  const logsDir = join(workDir, "logs");
  const logPath = join(logsDir, "build.log");
  return {
    args,
    outputPath,
    workDir,
    runtimeDir,
    downloadsDir: join(workDir, "downloads"),
    logsDir,
    logPath,
    envPath: join(logsDir, "environment.json"),
    keepWork: Boolean(args["keep-work"]),
    force: Boolean(args.force),
    logger: createLogger(logPath),
  };
}

/** @param {BuildContext} context */
async function prepareBuildWorkspace(context) {
  const { logger, outputPath, workDir } = context;
  logger.line(
    `MGT Flux ROCm prebuilt runtime build started at ${new Date().toISOString()}`,
  );
  logger.line(`workDir=${workDir}`);
  logger.line(`runtimeDir=${context.runtimeDir}`);
  logger.line(`outputPath=${outputPath}`);
  logger.line(`workDir free=${formatOptionalBytes(getPathFreeBytes(workDir))}`);
  logger.line(
    `outputDir free=${formatOptionalBytes(getPathFreeBytes(dirname(outputPath)))}`,
  );
  await Promise.all([
    mkdir(context.logsDir, { recursive: true }),
    mkdir(context.downloadsDir, { recursive: true }),
    mkdir(dirname(outputPath), { recursive: true }),
  ]);
  ensureBuildDiskSpace({ workDir, outputPath, logger });
  assertSupportedBuildHost(context);
}

/** @param {BuildContext} context */
function assertSupportedBuildHost(context) {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("This runtime builder must be run on Windows x64.");
  }
  if (existsSync(context.outputPath) && !context.force) {
    throw new Error(
      `${context.outputPath} already exists. Use --force to overwrite it.`,
    );
  }
}

/** @param {BuildContext} context @returns {Promise<PreparedRuntime>} */
async function buildRuntime(context) {
  const nativeBuildEnv = resolveWindowsNativeBuildEnv();
  if (!nativeBuildEnv) {
    throw new Error(formatWindowsNativeBuildToolsMissingMessage());
  }
  const gpuTargets = resolveGpuTargets(context.args);
  await recordBuildEnvironment(context, nativeBuildEnv, gpuTargets);
  const paths = await prepareRuntimeDirectories(context);
  const installEnv = await installPythonPackages(
    context,
    paths,
    nativeBuildEnv,
    gpuTargets,
  );
  return { ...paths, installEnv, nativeBuildEnv, gpuTargets };
}

/**
 * @param {BuildContext} context
 * @param {NativeBuildEnv} nativeBuildEnv
 * @param {string} gpuTargets
 */
async function recordBuildEnvironment(context, nativeBuildEnv, gpuTargets) {
  await writeFile(
    context.envPath,
    `${JSON.stringify(snapshotEnvironment(nativeBuildEnv, gpuTargets), null, 2)}\n`,
    "utf8",
  );
  context.logger.line(`environment snapshot: ${context.envPath}`);
  context.logger.line(`Windows SDK: ${nativeBuildEnv.sdkVersion || "unknown"}`);
  context.logger.line(`GPU targets: ${gpuTargets}`);
}

/** @param {BuildContext} context */
async function prepareRuntimeDirectories(context) {
  if (context.force) {
    await rm(context.runtimeDir, { recursive: true, force: true });
  }
  await mkdir(context.runtimeDir, { recursive: true });
  const pythonDir = join(
    context.runtimeDir,
    "bootstrap-python",
    `python-${pythonVersion}`,
  );
  const packageDir = join(context.runtimeDir, "p");
  await rm(packageDir, { recursive: true, force: true });
  await mkdir(packageDir, { recursive: true });
  return { pythonDir, pythonExe: join(pythonDir, "python.exe"), packageDir };
}

/**
 * @param {BuildContext} context
 * @param {{ pythonDir: string; pythonExe: string; packageDir: string }} paths
 * @param {NativeBuildEnv} nativeBuildEnv
 * @param {string} gpuTargets
 */
async function installPythonPackages(
  context,
  paths,
  nativeBuildEnv,
  gpuTargets,
) {
  const { logger, runtimeDir } = context;
  const { packageDir, pythonDir, pythonExe } = paths;
  await prepareEmbeddedPython({
    pythonDir,
    pythonExe,
    packageDir,
    downloadsDir: context.downloadsDir,
    logger,
  });
  const bootstrapEnv = buildPythonPackageInstallEnv(runtimeDir, packageDir);
  await installBootstrapPackages(pythonExe, packageDir, bootstrapEnv, logger);
  await initializeRocmSdk({ pythonExe, packageDir, runtimeDir, logger });
  const installEnv = buildRuntimeEnv(
    runtimeDir,
    packageDir,
    nativeBuildEnv,
    gpuTargets,
    logger,
  );
  await run(
    pythonExe,
    ["-m", "pip", "install", "--target", packageDir, ...fluxPackages],
    { env: installEnv, logger },
  );
  return installEnv;
}

/**
 * @param {string} pythonExe
 * @param {string} packageDir
 * @param {NodeJS.ProcessEnv} env
 * @param {BuildLogger} logger
 */
async function installBootstrapPackages(pythonExe, packageDir, env, logger) {
  await run(
    pythonExe,
    ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"],
    { env, logger },
  );
  await run(
    pythonExe,
    ["-m", "pip", "install", "--upgrade", ...buildPackages],
    { env, logger },
  );
  await run(
    pythonExe,
    ["-m", "pip", "install", "--target", packageDir, ...rocmPackageUrls],
    { env, logger },
  );
}

/** @param {BuildContext} context @param {PreparedRuntime} prepared */
async function packageRuntime(context, prepared) {
  const workerSource = join(rootDir, "src", "main", "runtime", workerFile);
  if (!isFile(workerSource)) {
    throw new Error(`${workerFile} was not found: ${workerSource}`);
  }
  await copyFile(workerSource, join(context.runtimeDir, workerFile));
  await verifyRuntime({
    pythonExe: prepared.pythonExe,
    packageDir: prepared.packageDir,
    env: prepared.installEnv,
    logger: context.logger,
  });
  await writeRuntimeManifest({
    runtimeDir: context.runtimeDir,
    gpuTargets: prepared.gpuTargets,
    nativeBuildEnv: prepared.nativeBuildEnv,
    logger: context.logger,
  });
  await createRuntimeZip({
    runtimeDir: context.runtimeDir,
    outputPath: context.outputPath,
    logger: context.logger,
  });
  const parts = await splitRuntimeArchiveForRelease({
    archivePath: context.outputPath,
    partBytes: releasePartBytes,
    logger: context.logger,
  });
  await writeRuntimeSidecars(context, prepared.gpuTargets, parts);
}

/** @param {BuildContext} context @param {string} gpuTargets @param {Array<{ file: string; bytes: number; sha256: string }>} parts */
async function writeRuntimeSidecars(context, gpuTargets, parts) {
  const sha256 = await sha256File(context.outputPath);
  const sidecar = {
    file: basename(context.outputPath),
    sha256,
    bytes: statSync(context.outputPath).size,
    createdAt: new Date().toISOString(),
    rocmVersion,
    pythonVersion,
    gpuTargets: gpuTargets ? gpuTargets.split(";") : [],
    parts,
  };
  await writeFile(
    `${context.outputPath}.sha256`,
    `${sha256}  ${basename(context.outputPath)}\n`,
    "utf8",
  );
  await writeFile(
    `${context.outputPath}.json`,
    `${JSON.stringify(sidecar, null, 2)}\n`,
    "utf8",
  );
  context.logger.line(`ZIP: ${context.outputPath}`);
  context.logger.line(`SHA256: ${sha256}`);
  context.logger.line(
    "MGT Flux ROCm prebuilt runtime build finished successfully.",
  );
}

module.exports = { createBuildContext, formatUnknownError, main };
