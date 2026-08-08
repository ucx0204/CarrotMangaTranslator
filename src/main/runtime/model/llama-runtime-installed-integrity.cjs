// @ts-check
const { createHash } = require("node:crypto");
const { readFileSync, readdirSync } = require("node:fs");
const path = require("node:path");

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
      } else if (entry.isFile() && isExecutableRuntimeFile(relative)) {
        hashes[relative] = hashFile(absolute);
      }
    }
  }
  if (Object.keys(hashes).length === 0) {
    throw new Error(
      "Installed llama runtime contains no hashable executable files.",
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
 * Validates both the trusted runtime descriptor binding and every executable
 * file hash. Callers use this immediately before a managed runtime is spawned,
 * not only while deciding whether an existing installation can be reused.
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
function isExecutableRuntimeFile(relativePath) {
  const name = path.posix.basename(relativePath).toLowerCase();
  return (
    name === "llama-server" ||
    name === "llama-cli" ||
    /\.(?:exe|dll|dylib|so|metal|metallib)$/i.test(name)
  );
}

/** @param {string} filePath */
function hashFile(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

module.exports = {
  collectInstalledRuntimeFileHashes,
  installedRuntimeHashesMatch,
  installedRuntimeMarkerMatches,
};
