// @ts-check

const { createHash } = require("node:crypto");
const { readFileSync, readdirSync } = require("node:fs");
const path = require("node:path");

const MANAGED_PYTHON_MARKER_FIELDS = [
  "version",
  "pythonUrl",
  "pythonSha256",
  "getPipUrl",
  "getPipSha256",
];

/** @param {Record<string, unknown>} marker @param {Record<string, unknown>} expected @returns {boolean} */
function managedPythonMarkerMatches(marker, expected) {
  return MANAGED_PYTHON_MARKER_FIELDS.every(
    (field) => marker[field] === expected[field],
  );
}

/** @param {string} pythonDir @returns {Record<string, string>} */
function collectManagedPythonExecutableHashes(pythonDir) {
  /** @type {Record<string, string>} */
  const hashes = {};
  for (const filePath of collectManagedPythonExecutableFiles(pythonDir)) {
    const relativePath = path.relative(pythonDir, filePath).replace(/\\/g, "/");
    hashes[relativePath] = calculateFileSha256Sync(filePath);
  }
  return hashes;
}

/** @param {string} pythonDir @param {unknown} stored @returns {boolean} */
function installedManagedPythonHashesMatch(pythonDir, stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return false;
  }
  const expected = /** @type {Record<string, unknown>} */ (stored);
  const actual = collectManagedPythonExecutableHashes(pythonDir);
  const names = Object.keys(actual).sort();
  return (
    names.length > 0 &&
    names.length === Object.keys(expected).length &&
    names.every(
      (name) =>
        typeof expected[name] === "string" && expected[name] === actual[name],
    )
  );
}

/** @param {string} root @returns {string[]} */
function collectManagedPythonExecutableFiles(root) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} dir */
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
      } else if (
        entry.isFile() &&
        /(?:\.exe|\.dll|\.pyd|\._pth)$/i.test(entry.name)
      ) {
        files.push(filePath);
      }
    }
  };
  visit(root);
  return files.sort();
}

/** @param {string} filePath @returns {string} */
function calculateFileSha256Sync(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

module.exports = {
  collectManagedPythonExecutableHashes,
  installedManagedPythonHashesMatch,
  managedPythonMarkerMatches,
};
