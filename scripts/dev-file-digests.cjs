const { createHash } = require("node:crypto");
const {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} = require("node:fs");
const { dirname } = require("node:path");

/** @typedef {{ identity: string; sha256: string }} FileDigest */

/**
 * Development-only reuse of content hashes. ctime and inode also participate,
 * so restoring mtime or replacing a same-sized file does not hide edits.
 * Production callers omit cacheFile and always read the exact bytes.
 * @param {string | undefined} cacheFile
 */
function createFileDigester(cacheFile) {
  const previous = readDigests(cacheFile);
  /** @type {Record<string, FileDigest>} */
  const next = Object.create(null);
  let changed = false;
  return {
    /** @param {string} filePath */
    digest(filePath) {
      const metadata = lstatSync(filePath, { bigint: true });
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`Cached content must be a real file: ${filePath}`);
      }
      const identity = fileIdentity(metadata);
      const cached = previous[filePath];
      if (cached?.identity === identity) {
        next[filePath] = cached;
        return { bytes: metadata.size, sha256: cached.sha256 };
      }
      const content = readFileSync(filePath);
      const after = lstatSync(filePath, { bigint: true });
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        fileIdentity(after) !== identity
      ) {
        throw new Error(`Cached file changed while reading: ${filePath}`);
      }
      const sha256 = createHash("sha256").update(content).digest("hex");
      next[filePath] = { identity, sha256 };
      changed = true;
      return { bytes: metadata.size, sha256 };
    },
    save() {
      if (
        !cacheFile ||
        (!changed && Object.keys(previous).length === Object.keys(next).length)
      )
        return;
      mkdirSync(dirname(cacheFile), { recursive: true });
      const temporary = `${cacheFile}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, files: next }));
      renameSync(temporary, cacheFile);
    },
  };
}

/** @param {import("node:fs").BigIntStats} metadata */
function fileIdentity(metadata) {
  return [
    metadata.dev,
    metadata.ino,
    metadata.size,
    metadata.mtimeNs,
    metadata.ctimeNs,
    metadata.birthtimeNs,
  ].join(":");
}

/** @param {string | undefined} cacheFile @returns {Record<string, FileDigest>} */
function readDigests(cacheFile) {
  if (!cacheFile) return Object.create(null);
  try {
    const parsed = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (
      parsed?.version !== 1 ||
      !parsed.files ||
      typeof parsed.files !== "object" ||
      Array.isArray(parsed.files)
    )
      return Object.create(null);
    /** @type {Record<string, FileDigest>} */
    const files = Object.create(null);
    for (const [name, value] of Object.entries(parsed.files)) {
      const record = /** @type {Partial<FileDigest> | null} */ (value);
      if (
        record &&
        typeof record.identity === "string" &&
        typeof record.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(record.sha256)
      ) {
        files[name] = { identity: record.identity, sha256: record.sha256 };
      }
    }
    return files;
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT"
    )
      return Object.create(null);
    throw error;
  }
}

module.exports = { createFileDigester };
