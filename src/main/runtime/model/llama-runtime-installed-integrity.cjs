// @ts-check
const { createHash } = require("node:crypto");
const {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} = require("node:fs");
const path = require("node:path");

const INSTALLED_RUNTIME_HASH_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_RUNTIME_HASH_IO = Object.freeze({
  closeSync,
  fstatSync,
  openSync,
  readSync,
});
/** @type {Buffer | null} */
let installedRuntimeHashBuffer = null;

/** @typedef {{ archive?: unknown; url?: unknown; sha256?: unknown }} MarkerArchive */
/** @typedef {{ id?: unknown; kind?: unknown; dir?: unknown; archives?: MarkerArchive[]; installedFileSha256?: unknown }} InstalledRuntimeMarker */
/** @typedef {{ id?: unknown; kind?: unknown; dir?: unknown; archive?: unknown; url?: unknown; sha256?: unknown; archives?: MarkerArchive[] }} RuntimeDescriptor */

/** @param {string} runtimeDir */
function collectInstalledRuntimeFileHashes(runtimeDir) {
  /** @type {Record<string, string>} */
  const hashes = {};
  const stack = [{ absolute: runtimeDir, relative: "" }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    for (const entry of readdirSync(current.absolute, {
      withFileTypes: true,
    })) {
      const absolute = path.join(current.absolute, entry.name);
      const relative = current.relative
        ? path.posix.join(current.relative, entry.name)
        : entry.name;
      if (entry.isDirectory()) {
        stack.push({ absolute, relative });
      } else if (entry.isFile() && isIntegrityProtectedRuntimeFile(relative)) {
        hashes[relative] = hashInstalledRuntimeFile(absolute);
      }
    }
  }
  if (Object.keys(hashes).length === 0) {
    throw new Error(
      "Installed llama runtime contains no integrity-protected files.",
    );
  }
  return Object.fromEntries(
    Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** @param {string} runtimeDir @param {unknown} expectedValue */
function installedRuntimeHashesMatch(runtimeDir, expectedValue) {
  if (
    !expectedValue ||
    typeof expectedValue !== "object" ||
    Array.isArray(expectedValue)
  ) {
    return false;
  }
  const expected = /** @type {Record<string, unknown>} */ (expectedValue);
  const entries = Object.entries(expected);
  if (entries.length === 0) return false;
  try {
    const actual = collectInstalledRuntimeFileHashes(runtimeDir);
    return (
      Object.keys(actual).length === entries.length &&
      entries.every(([relativePath, digest]) =>
        validInstalledFile(runtimeDir, actual, relativePath, digest),
      )
    );
  } catch (_error) {
    return false;
  }
}

/**
 * Validates both the trusted runtime descriptor binding and every protected
 * runtime-file hash. Callers use this immediately before a managed runtime is
 * spawned, not only while deciding whether an existing installation can be
 * reused.
 *
 * @param {string} runtimeDir
 * @param {RuntimeDescriptor} runtime
 * @param {string} markerFileName
 */
function installedRuntimeMarkerMatches(
  runtimeDir,
  runtime,
  markerFileName = ".mgt-runtime.json",
) {
  try {
    const marker = /** @type {InstalledRuntimeMarker} */ (
      JSON.parse(readFileSync(path.join(runtimeDir, markerFileName), "utf8"))
    );
    if (
      marker.id !== runtime.id ||
      marker.kind !== runtime.kind ||
      marker.dir !== runtime.dir
    ) {
      return false;
    }
    const expectedArchives = runtimeArchives(runtime);
    const markerArchives = Array.isArray(marker.archives)
      ? marker.archives
      : [];
    if (
      markerArchives.length !== expectedArchives.length ||
      !expectedArchives.every((archive, index) =>
        archiveDescriptorsMatch(markerArchives[index], archive),
      )
    ) {
      return false;
    }
    return installedRuntimeHashesMatch(runtimeDir, marker.installedFileSha256);
  } catch (_error) {
    return false;
  }
}

/** @param {MarkerArchive | undefined} left @param {MarkerArchive} right */
function archiveDescriptorsMatch(left, right) {
  return (
    left?.archive === right.archive &&
    left?.url === right.url &&
    left?.sha256 === right.sha256 &&
    /^[a-f0-9]{64}$/.test(String(right.sha256 || ""))
  );
}

/** @param {RuntimeDescriptor} runtime @returns {MarkerArchive[]} */
function runtimeArchives(runtime) {
  if (Array.isArray(runtime.archives) && runtime.archives.length > 0) {
    return runtime.archives;
  }
  return runtime.archive && runtime.url
    ? [
        {
          archive: runtime.archive,
          url: runtime.url,
          sha256: runtime.sha256,
        },
      ]
    : [];
}

/** @param {string} runtimeDir @param {Record<string, string>} actual @param {string} relativePath @param {unknown} digest */
function validInstalledFile(runtimeDir, actual, relativePath, digest) {
  if (!/^[a-f0-9]{64}$/.test(String(digest))) return false;
  const absolute = path.resolve(runtimeDir, relativePath);
  const relative = path.relative(path.resolve(runtimeDir), absolute);
  return (
    !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    actual[relativePath] === digest
  );
}

/** @param {string} relativePath */
function isIntegrityProtectedRuntimeFile(relativePath) {
  const normalized = String(relativePath).replace(/\\/g, "/").toLowerCase();
  const name = path.posix.basename(normalized);
  return (
    name === "llama-server" ||
    name === "llama-cli" ||
    /\.(?:exe|dll|dylib|so|metal|metallib)$/i.test(name) ||
    (isRocmKernelLibraryPath(normalized) && /\.(?:co|dat|hsaco)$/i.test(name))
  );
}

/** @param {string} normalizedRelativePath */
function isRocmKernelLibraryPath(normalizedRelativePath) {
  return (
    normalizedRelativePath.startsWith("rocblas/") ||
    normalizedRelativePath.startsWith("hipblaslt/")
  );
}

/**
 * @typedef {{
 *   closeSync: (fd: number) => void;
 *   fstatSync: (fd: number) => { isFile: () => boolean; size: number };
 *   openSync: (filePath: string, flags: string) => number;
 *   readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => number;
 * }} RuntimeHashIo
 */

/** @returns {Buffer} */
function getInstalledRuntimeHashBuffer() {
  if (!installedRuntimeHashBuffer) {
    installedRuntimeHashBuffer = Buffer.allocUnsafe(
      INSTALLED_RUNTIME_HASH_CHUNK_BYTES,
    );
  }
  return installedRuntimeHashBuffer;
}

/** @param {string} filePath @param {RuntimeHashIo} [io] */
function hashInstalledRuntimeFile(filePath, io = DEFAULT_RUNTIME_HASH_IO) {
  const fd = io.openSync(filePath, "r");
  try {
    const initial = io.fstatSync(fd);
    if (
      !initial.isFile() ||
      !Number.isSafeInteger(initial.size) ||
      initial.size < 0
    ) {
      throw new Error(`Installed llama runtime file is invalid: ${filePath}`);
    }
    const hash = createHash("sha256");
    const buffer = getInstalledRuntimeHashBuffer();
    let position = 0;
    while (position < initial.size) {
      const requested = Math.min(buffer.length, initial.size - position);
      const bytesRead = io.readSync(fd, buffer, 0, requested, position);
      if (
        !Number.isSafeInteger(bytesRead) ||
        bytesRead < 1 ||
        bytesRead > requested
      ) {
        throw new Error(
          `Installed llama runtime file changed while hashing: ${filePath}`,
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (io.fstatSync(fd).size !== initial.size) {
      throw new Error(
        `Installed llama runtime file changed while hashing: ${filePath}`,
      );
    }
    return hash.digest("hex");
  } finally {
    io.closeSync(fd);
  }
}

module.exports = {
  INSTALLED_RUNTIME_HASH_CHUNK_BYTES,
  collectInstalledRuntimeFileHashes,
  hashInstalledRuntimeFile,
  installedRuntimeHashesMatch,
  installedRuntimeMarkerMatches,
};
