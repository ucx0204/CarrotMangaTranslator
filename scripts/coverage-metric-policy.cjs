// F14 moved every session branch into the application service. Enforce the
// historical branch floor on its actual owner, not by adding fake facade branches.
const EXTRACTED_BRANCH_OWNERS = new Map([
  [
    "src/main/imageRedactionWorkspaceSessions.ts",
    "src/main/application/redactionWorkspaceService.ts",
  ],
]);

/**
 * @param {string} file
 * @param {string} metric
 * @param {number} total
 * @param {Record<string, unknown>} introducedFloors
 * @returns {string}
 */
function resolveCoverageMetricOwner(file, metric, total, introducedFloors) {
  const owner =
    metric === "branches" && total === 0
      ? EXTRACTED_BRANCH_OWNERS.get(file)
      : undefined;
  if (!owner) return file;
  if (!Object.hasOwn(introducedFloors, owner))
    throw new Error(
      `Extracted branch owner is missing its own coverage floor: ${owner}`,
    );
  // The original floor is unchanged; the owner must also satisfy its own floor.
  return owner;
}

/**
 * @param {{total:number, covered:number}} actual
 * @param {{total:number, covered:number}} baseline
 */
function isCoverageRatioBelow(actual, baseline) {
  if (baseline.total === 0) {
    return actual.covered !== actual.total;
  }
  if (actual.total === 0) return true;
  return (
    BigInt(actual.covered) * BigInt(baseline.total) <
    BigInt(baseline.covered) * BigInt(actual.total)
  );
}

module.exports = { resolveCoverageMetricOwner, isCoverageRatioBelow };
