"use strict";

const POLICY_VERSION = "font-matching-page-relative-role-qa-v2";

/**
 * @typedef {{
 *   policyVersion?: string,
 *   status: string,
 *   originalRole: string,
 *   projectedRole: string,
 *   clusterBodyAnchorFontId?: string | null,
 *   baselinePageConsistencyState?: Record<string, unknown> | null,
 *   preferredPeerFontId?: string | null,
 *   reasonCodes?: string[],
 * }} PageRelativeRoleQaAuditRow
 */

/**
 * @typedef {{
 *   blockId?: string,
 *   pageRelativeRoleQa?: PageRelativeRoleQaAuditRow,
 * }} PixelInferenceTraceRow
 */

/**
 * Summarize an explicitly enabled page-relative QA trace. Every serialized
 * pixel-inference row must carry its audit payload; a partial trace would make
 * the experiment indistinguishable from a stale or bypassed runtime.
 *
 * @param {any} trace
 */
function summarizePageRelativeRoleQa(trace) {
  if (trace?.qaPageRelativeRoleReroute !== true) return null;
  if (!Array.isArray(trace.pixelInference)) {
    throw new Error("Page-relative role QA inference trace is missing.");
  }
  const inferenceRows = /** @type {PixelInferenceTraceRow[]} */ (
    trace.pixelInference
  );
  const rows = inferenceRows.map((entry) => {
    if (!entry?.pageRelativeRoleQa) {
      throw new Error(
        `Page-relative role QA audit is missing for inference row: ${entry?.blockId || "unknown"}`,
      );
    }
    return entry.pageRelativeRoleQa;
  });
  /** @type {Record<string, number>} */
  const statusCounts = {};
  /** @type {Record<string, number>} */
  const reasonCounts = {};
  let plannedRoleChanges = 0;
  let effectiveRoleChanges = 0;
  let plannedPeerPreferences = 0;
  let effectivePeerPreferences = 0;
  // The inference trace records only the pre-downstream anchor proposal.
  // It cannot prove that the later raw-top3 consistency guard applied it.
  let plannedClusterBodyAnchorRows = 0;
  let baselinePageStateRows = 0;
  for (const row of rows) {
    assertPageRelativeQaPolicyVersion(row);
    statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;
    const roleChanged = row.originalRole !== row.projectedRole;
    const peerPreferred = Boolean(row.preferredPeerFontId);
    const effective = row.status === "applied";
    if (roleChanged) plannedRoleChanges += 1;
    if (roleChanged && effective) effectiveRoleChanges += 1;
    if (peerPreferred) plannedPeerPreferences += 1;
    if (peerPreferred && effective) effectivePeerPreferences += 1;
    if (row.clusterBodyAnchorFontId) plannedClusterBodyAnchorRows += 1;
    if (row.baselinePageConsistencyState) baselinePageStateRows += 1;
    for (const reason of row.reasonCodes || []) {
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }
  }
  return {
    policyVersion: rows[0]?.policyVersion || POLICY_VERSION,
    inferredRows: rows.length,
    plannedRoleChanges,
    effectiveRoleChanges,
    plannedPeerPreferences,
    effectivePeerPreferences,
    plannedClusterBodyAnchorRows,
    baselinePageStateRows,
    statusCounts,
    reasonCounts,
  };
}

/** @param {PageRelativeRoleQaAuditRow} row */
function assertPageRelativeQaPolicyVersion(row) {
  if (row.policyVersion === POLICY_VERSION) return;
  throw new Error(
    `Page-relative role QA policy version mismatch: ${row.policyVersion || "missing"}`,
  );
}

module.exports = { summarizePageRelativeRoleQa };
