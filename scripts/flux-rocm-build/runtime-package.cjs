/**
 * @typedef {{ line(text: string): void; raw(text: string): void; close(): void }} BuildLogger
 * @typedef {{ sdkVersion?: string; pathEntries: string[]; includePaths: string[]; libPaths: string[] }} NativeBuildEnv
 * @typedef {{ pythonExe: string; packageDir: string; env: NodeJS.ProcessEnv; logger: BuildLogger }} VerifyRuntimeOptions
 * @typedef {{ runtimeDir: string; gpuTargets: string; nativeBuildEnv: NativeBuildEnv; logger: BuildLogger }} RuntimeManifestOptions
 * @typedef {{ runtimeDir: string; outputPath: string; logger: BuildLogger }} RuntimeZipOptions
 */
const { createHash } = require("node:crypto");
const { existsSync, readdirSync, rmSync, statSync } = require("node:fs");
const { open: openFile, writeFile } = require("node:fs/promises");
const { basename, dirname, join } = require("node:path");
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

/**
 * @param {{ archivePath: string; partBytes: number; logger: BuildLogger }} options
 * @returns {Promise<Array<{ file: string; bytes: number; sha256: string }>>}
 */
async function splitRuntimeArchiveForRelease({
  archivePath,
  partBytes,
  logger,
}) {
  if (!Number.isSafeInteger(partBytes) || partBytes < 1) {
    throw new TypeError("release part size must be a positive safe integer");
  }
  removeExistingReleaseParts(archivePath);
  const source = await openFile(archivePath, "r");
  try {
    return await splitOpenRuntimeArchive({
      archivePath,
      partBytes,
      logger,
      source,
    });
  } catch (error) {
    removeExistingReleaseParts(archivePath);
    throw error;
  } finally {
    await source.close();
  }
}

/** @param {{ archivePath: string; partBytes: number; logger: BuildLogger; source: import("node:fs/promises").FileHandle }} options */
async function splitOpenRuntimeArchive(options) {
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  const state = { sourceOffset: 0 };
  /** @type {Array<{ file: string; bytes: number; sha256: string }>} */
  const parts = [];
  for (let partIndex = 1; ; partIndex += 1) {
    const part = await writeRuntimeReleasePart(
      options,
      buffer,
      state,
      partIndex,
    );
    if (!part) break;
    parts.push(part);
    options.logger.line(
      `release part: ${part.file} (${part.bytes} bytes, sha256=${part.sha256})`,
    );
    if (part.bytes < options.partBytes) break;
  }
  return parts;
}

/** @param {{ archivePath: string; partBytes: number; source: import("node:fs/promises").FileHandle }} options @param {Buffer} buffer @param {{ sourceOffset: number }} state @param {number} partIndex */
async function writeRuntimeReleasePart(options, buffer, state, partIndex) {
  const partPath = `${options.archivePath}.part-${String(partIndex).padStart(3, "0")}`;
  const destination = await openFile(partPath, "wx", 0o600);
  let part;
  try {
    part = await copyRuntimeReleasePart(options, destination, buffer, state);
  } finally {
    await destination.close();
  }
  if (!part) rmSync(partPath, { force: true });
  return part ? { file: basename(partPath), ...part } : null;
}

/** @param {{ partBytes: number; source: import("node:fs/promises").FileHandle }} options @param {import("node:fs/promises").FileHandle} destination @param {Buffer} buffer @param {{ sourceOffset: number }} state */
async function copyRuntimeReleasePart(options, destination, buffer, state) {
  const hash = createHash("sha256");
  let writtenBytes = 0;
  while (writtenBytes < options.partBytes) {
    const requestedBytes = Math.min(
      buffer.length,
      options.partBytes - writtenBytes,
    );
    const { bytesRead } = await options.source.read(
      buffer,
      0,
      requestedBytes,
      state.sourceOffset,
    );
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    await writeCompleteBuffer(destination, chunk);
    state.sourceOffset += bytesRead;
    writtenBytes += bytesRead;
  }
  return writtenBytes > 0
    ? { bytes: writtenBytes, sha256: hash.digest("hex") }
    : null;
}

/** @param {import("node:fs/promises").FileHandle} destination @param {Buffer} buffer */
async function writeCompleteBuffer(destination, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await destination.write(
      buffer,
      offset,
      buffer.length - offset,
    );
    if (bytesWritten < 1) {
      throw new Error("Failed to write Flux ROCm release part.");
    }
    offset += bytesWritten;
  }
}

/** @param {string} archivePath */
function removeExistingReleaseParts(archivePath) {
  const outputDir = dirname(archivePath);
  const prefix = `${basename(archivePath)}.part-`;
  for (const name of readdirSync(outputDir)) {
    if (name.startsWith(prefix) && /^\d{3}$/.test(name.slice(prefix.length))) {
      rmSync(join(outputDir, name), { force: true });
    }
  }
}

module.exports = {
  createRuntimeZip,
  splitRuntimeArchiveForRelease,
  verifyRuntime,
  writeRuntimeManifest,
};
