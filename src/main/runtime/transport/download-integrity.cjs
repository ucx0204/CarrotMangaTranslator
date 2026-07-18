// @ts-check
const { createHash } = require("node:crypto");
const { createReadStream, readFileSync, statSync } = require("node:fs");
const { writeFile } = require("node:fs/promises");

const INTEGRITY_MARKER_SUFFIX = ".mgt-sha256.json";

/** @param {unknown} value */
function normalizeExpectedSha256(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : "";
}

/** @param {string} filePath */
function integrityMarkerPath(filePath) {
  return `${filePath}${INTEGRITY_MARKER_SUFFIX}`;
}

/** @param {string} filePath @param {unknown} expectedSha256 */
function hasCurrentIntegrityMarker(filePath, expectedSha256) {
  const expected = normalizeExpectedSha256(expectedSha256);
  if (!expected) return false;
  try {
    const stat = statSync(filePath);
    const marker =
      /** @type {{ sha256?: unknown; size?: unknown; mtimeMs?: unknown }} */ (
        JSON.parse(readFileSync(integrityMarkerPath(filePath), "utf8"))
      );
    return (
      marker.sha256 === expected &&
      marker.size === stat.size &&
      marker.mtimeMs === stat.mtimeMs
    );
  } catch (_error) {
    return false;
  }
}

/** @param {string} filePath */
async function calculateFileSha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

/** @param {string} filePath @param {unknown} expectedSha256 */
async function verifyFileSha256(filePath, expectedSha256) {
  const expected = normalizeExpectedSha256(expectedSha256);
  if (!expected) return { verified: false, expected: "", actual: "" };
  if (hasCurrentIntegrityMarker(filePath, expected)) {
    return { verified: true, expected, actual: expected };
  }
  const actual = await calculateFileSha256(filePath);
  if (actual !== expected) return { verified: false, expected, actual };
  await writeIntegrityMarker(filePath, expected);
  return { verified: true, expected, actual };
}

/** @param {string} filePath @param {string} sha256 */
async function writeIntegrityMarker(filePath, sha256) {
  try {
    const stat = statSync(filePath);
    await writeFile(
      integrityMarkerPath(filePath),
      `${JSON.stringify({ sha256, size: stat.size, mtimeMs: stat.mtimeMs })}\n`,
      "utf8",
    );
  } catch (_error) {
    // error-policy-allow: the payload was already verified; a missing cache
    // marker only causes another checksum pass on the next launch.
  }
}

module.exports = {
  calculateFileSha256,
  hasCurrentIntegrityMarker,
  integrityMarkerPath,
  normalizeExpectedSha256,
  verifyFileSha256,
  writeIntegrityMarker,
};
