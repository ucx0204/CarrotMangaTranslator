const {
  existsSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
} = require("node:fs");
const { join, relative, resolve } = require("node:path");

const repoRoot = resolve(__dirname, "..");

/**
 * @param {string} target
 * @returns {string}
 */
function assertInsideRepo(target) {
  const resolved = resolve(target);
  const rel = relative(repoRoot, resolved);
  if (rel.startsWith("..") || resolve(rel) === rel) {
    throw new Error(`Refusing to clean outside repository: ${resolved}`);
  }
  return resolved;
}

/** @param {string} target */
function removeFile(target) {
  const resolved = assertInsideRepo(target);
  if (!existsSync(resolved)) {
    return;
  }
  unlinkSync(resolved);
  console.log(`removed ${relative(repoRoot, resolved)}`);
}

/** @param {string} target */
function removeDirectory(target) {
  const resolved = assertInsideRepo(target);
  if (!existsSync(resolved)) {
    return;
  }
  for (const entry of readdirSync(resolved)) {
    const entryPath = join(resolved, entry);
    if (statSync(entryPath).isDirectory()) {
      removeDirectory(entryPath);
    } else {
      removeFile(entryPath);
    }
  }
  rmdirSync(resolved);
  console.log(`removed ${relative(repoRoot, resolved)}`);
}

removeDirectory(join(repoRoot, "src", "main", "runtime", "__pycache__"));
removeFile(join(repoRoot, "settings.json"));
