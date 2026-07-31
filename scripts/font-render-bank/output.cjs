// @ts-check
const {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
} = require("node:fs");
const { rm } = require("node:fs/promises");
const {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
} = require("node:path");
const { OWNER, SCHEMA_VERSION } = require("./spec.cjs");

const MARKER_FILE = ".font-render-bank-owned.json";

/** @param {string} outputDirectory */
function assertReplaceableOutput(outputDirectory) {
  assertSafeTarget(outputDirectory);
  if (!existsSync(outputDirectory)) return;
  if (!lstatSync(outputDirectory).isDirectory()) {
    throw new Error(
      `Font render-bank output is not a directory: ${outputDirectory}.`,
    );
  }
  if (readdirSync(outputDirectory).length === 0) return;
  assertOwnedOutput(outputDirectory);
}

/** @param {string} outputDirectory */
function assertOwnedOutput(outputDirectory) {
  const markerPath = join(outputDirectory, MARKER_FILE);
  if (!existsSync(markerPath)) {
    throw new Error(
      `Refusing to replace/check unowned font render-bank output: ${outputDirectory}.`,
    );
  }
  const marker = readJson(markerPath);
  if (marker.owner !== OWNER || marker.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `Invalid font render-bank ownership marker: ${markerPath}.`,
    );
  }
}

/** @param {string} outputDirectory */
function createStagingDirectory(outputDirectory) {
  const parent = dirname(outputDirectory);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(
    join(parent, `.${basename(outputDirectory)}.building-`),
  );
  assertChildPath(staging, parent);
  return staging;
}

/** @param {string} root */
function createRunDirectory(root) {
  const temporaryRoot = join(root, ".tmp");
  mkdirSync(temporaryRoot, { recursive: true });
  const runDirectory = mkdtempSync(join(temporaryRoot, "font-render-bank-"));
  assertChildPath(runDirectory, temporaryRoot);
  return runDirectory;
}

/** @param {string} outputDirectory @param {string} stagingDirectory */
async function replaceOutputDirectory(outputDirectory, stagingDirectory) {
  const backupDirectory = `${outputDirectory}.backup-${process.pid}`;
  if (existsSync(backupDirectory)) {
    throw new Error(
      `Refusing existing font render-bank backup: ${backupDirectory}.`,
    );
  }
  let backedUp = false;
  try {
    if (existsSync(outputDirectory)) {
      renameSync(outputDirectory, backupDirectory);
      backedUp = true;
    }
    renameSync(stagingDirectory, outputDirectory);
  } catch (error) {
    if (backedUp && !existsSync(outputDirectory)) {
      renameSync(backupDirectory, outputDirectory);
    }
    throw error;
  }
  if (backedUp) {
    await removeOwnedTemporaryAsync(backupDirectory, dirname(outputDirectory));
  }
}

/** @param {string} targetPath @param {string} parentPath */
async function removeOwnedTemporaryAsync(targetPath, parentPath) {
  if (!existsSync(targetPath)) return;
  assertChildPath(targetPath, parentPath);
  await rm(targetPath, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

/** @param {string} targetPath @param {string} parentPath */
async function tryRemoveOwnedTemporaryAsync(targetPath, parentPath) {
  if (!existsSync(targetPath)) return;
  try {
    await removeOwnedTemporaryAsync(targetPath, parentPath);
  } catch (error) {
    console.warn(
      `[font-render-bank] could not remove temporary path ${targetPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** @param {string} targetPath */
function assertSafeTarget(targetPath) {
  const resolved = resolve(targetPath);
  const parsed = parse(resolved);
  if (resolved === parsed.root || basename(resolved).length < 3) {
    throw new Error(`Refusing unsafe font render-bank target: ${targetPath}.`);
  }
}

/** @param {string} targetPath @param {string} parentPath */
function assertChildPath(targetPath, parentPath) {
  const child = relative(resolve(parentPath), resolve(targetPath));
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new Error(`Path escapes font render-bank root: ${targetPath}.`);
  }
}

/** @param {string} directory */
function listFiles(directory) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} current */
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else files.push(relative(directory, absolute).replace(/\\/g, "/"));
    }
  }
  visit(directory);
  return files.sort();
}

/** @param {Buffer} bytes */
function readPngDimensions(bytes) {
  if (
    bytes.length < 24 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    throw new Error("Font render artifact is not a valid PNG.");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** @param {string} path */
function readJson(path) {
  return /** @type {Record<string, any>} */ (
    JSON.parse(readFileSync(path, "utf8"))
  );
}

module.exports = {
  MARKER_FILE,
  assertChildPath,
  assertOwnedOutput,
  assertReplaceableOutput,
  createRunDirectory,
  createStagingDirectory,
  listFiles,
  readJson,
  readPngDimensions,
  replaceOutputDirectory,
  tryRemoveOwnedTemporaryAsync,
};
