const {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} = require("node:fs");
const { isAbsolute, join, relative, resolve } = require("node:path");

/** @typedef {{ root?: string; outputDir?: string }} PrepareRuntimeAssetsOptions */

/** @param {PrepareRuntimeAssetsOptions} [options] */
function prepareRuntimeAssets(options = {}) {
  const root = options.root ?? join(__dirname, "..");
  const sourceDir = join(root, "src", "main", "runtime");
  const outputDir = options.outputDir ?? join(root, "out", "app-runtime");

  if (!existsSync(sourceDir)) {
    throw new Error(`Runtime source directory is missing: ${sourceDir}`);
  }

  assertSafeOutputDirectory(root, sourceDir, outputDir);
  emptyDirectory(outputDir);
  mkdirSync(outputDir, { recursive: true });
  copyDirectoryContents(sourceDir, outputDir);

  return outputDir;
}

/** @param {string} directory */
function emptyDirectory(directory) {
  if (!existsSync(directory)) {
    return;
  }
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Runtime output must be a real directory: ${directory}`);
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      emptyDirectory(entryPath);
      rmdirSync(entryPath);
      continue;
    }
    unlinkSync(entryPath);
  }
}

/**
 * @param {string} sourceDir
 * @param {string} outputDir
 */
function copyDirectoryContents(sourceDir, outputDir) {
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    const outputPath = join(outputDir, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(outputPath, { recursive: true });
      copyDirectoryContents(sourcePath, outputPath);
      continue;
    }
    if (entry.isFile()) {
      copyFileSync(sourcePath, outputPath);
    }
  }
}

/**
 * @param {string} root
 * @param {string} sourceDir
 * @param {string} outputDir
 */
function assertSafeOutputDirectory(root, sourceDir, outputDir) {
  const resolvedRoot = resolve(root);
  const resolvedSource = resolve(sourceDir);
  const resolvedOutput = resolve(outputDir);
  if (
    !isStrictDescendant(resolvedRoot, resolvedOutput) ||
    isSameOrDescendant(resolvedSource, resolvedOutput) ||
    isSameOrDescendant(resolvedOutput, resolvedSource)
  ) {
    throw new Error(`Refusing to clean unsafe runtime output: ${outputDir}`);
  }
}

/**
 * @param {string} parent
 * @param {string} candidate
 */
function isStrictDescendant(parent, candidate) {
  const child = relative(parent, candidate);
  return Boolean(child) && !child.startsWith("..") && !isAbsolute(child);
}

/**
 * @param {string} parent
 * @param {string} candidate
 */
function isSameOrDescendant(parent, candidate) {
  return (
    resolve(parent) === resolve(candidate) ||
    isStrictDescendant(parent, candidate)
  );
}

module.exports = {
  prepareRuntimeAssets,
};

if (require.main === module) {
  const outputDir = prepareRuntimeAssets();
  console.log(`[runtime] prepared ${outputDir}`);
}
