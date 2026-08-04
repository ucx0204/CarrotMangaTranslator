/* eslint-disable @typescript-eslint/ban-ts-comment -- this QA tool compares versioned runtime reports */
// @ts-nocheck -- comparison accepts versioned reports from multiple candidate runtimes.
const fsp = require("node:fs/promises");
const path = require("node:path");

/** @param {string} filePath */
async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/**
 * Compare two runs over the exact same frozen cohort. This report is a
 * regression aid, not an automatic claim of visual superiority.
 * @param {string} baselineDir
 * @param {string} candidateDir
 */
async function compareRuns(baselineDir, candidateDir) {
  const baseline = await readJson(path.join(baselineDir, "run-report.json"));
  const candidate = await readJson(path.join(candidateDir, "run-report.json"));
  if (baseline.cohortDigest !== candidate.cohortDigest) {
    throw new Error(
      "Baseline and candidate runs do not use the same frozen cohort.",
    );
  }
  const baselinePages = new Map(
    (baseline.pages || []).map((page) => [page.sourcePageId, page]),
  );
  const candidatePages = new Map(
    (candidate.pages || []).map((page) => [page.sourcePageId, page]),
  );
  const pageRows = [];
  const blockRows = [];
  for (const [pageId, baselinePage] of baselinePages) {
    const candidatePage = candidatePages.get(pageId);
    if (!candidatePage) {
      pageRows.push({ sourcePageId: pageId, status: "candidate_missing" });
      continue;
    }
    const baselineBlocks = Array.isArray(baselinePage.fontDecisions)
      ? baselinePage.fontDecisions
      : [];
    const candidateBlocks = Array.isArray(candidatePage.fontDecisions)
      ? candidatePage.fontDecisions
      : [];
    const pageBlockRows = comparePageBlocks(
      pageId,
      baselineBlocks,
      candidateBlocks,
    );
    blockRows.push(...pageBlockRows);
    pageRows.push({
      sourcePageId: pageId,
      status: "paired",
      blockCountBaseline: baselineBlocks.length,
      blockCountCandidate: candidateBlocks.length,
      fontChanges: pageBlockRows.filter((row) => row.selectedFontChanged)
        .length,
      outputImageChanged:
        baselinePage.renderedImageSha256 !== candidatePage.renderedImageSha256,
      baselineRenderedImage: baselinePage.renderedImagePath,
      candidateRenderedImage: candidatePage.renderedImagePath,
    });
  }
  for (const pageId of candidatePages.keys()) {
    if (!baselinePages.has(pageId)) {
      pageRows.push({ sourcePageId: pageId, status: "baseline_missing" });
    }
  }
  const baselineSummary = summarizeRunDecisions(baseline);
  const candidateSummary = summarizeRunDecisions(candidate);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    cohort: candidate.cohort,
    cohortDigest: candidate.cohortDigest,
    baseline: {
      runId: baseline.runId,
      candidateId: baseline.candidateId,
      ...baselineSummary,
    },
    candidate: {
      runId: candidate.runId,
      candidateId: candidate.candidateId,
      ...candidateSummary,
    },
    deltas: {
      completedPages:
        candidateSummary.completedPages - baselineSummary.completedPages,
      failedPages: candidateSummary.failedPages - baselineSummary.failedPages,
      automaticApplyRate:
        candidateSummary.automaticApplyRate -
        baselineSummary.automaticApplyRate,
      meanAppliedConfidence:
        candidateSummary.meanAppliedConfidence -
        baselineSummary.meanAppliedConfidence,
      distinctSelectedFonts:
        candidateSummary.distinctSelectedFonts -
        baselineSummary.distinctSelectedFonts,
    },
    guardrails: buildGuardrails(baselineSummary, candidateSummary, pageRows),
    reviewStatus: "manual_visual_review_required",
    pages: pageRows,
    blocks: blockRows,
  };
}

/** @param {string} pageId @param {any[]} baselineBlocks @param {any[]} candidateBlocks */
function comparePageBlocks(pageId, baselineBlocks, candidateBlocks) {
  const size = Math.max(baselineBlocks.length, candidateBlocks.length);
  const rows = [];
  for (let index = 0; index < size; index += 1) {
    const baseline = asRecord(baselineBlocks[index]);
    const candidate = asRecord(candidateBlocks[index]);
    rows.push({
      sourcePageId: pageId,
      blockIndex: index,
      status: !baselineBlocks[index]
        ? "baseline_missing"
        : !candidateBlocks[index]
          ? "candidate_missing"
          : "paired",
      sourceText: candidate.sourceText ?? baseline.sourceText ?? "",
      translatedText: candidate.translatedText ?? baseline.translatedText ?? "",
      roleBaseline: baseline.role ?? null,
      roleCandidate: candidate.role ?? null,
      selectedFontBaseline: baseline.selectedFontId ?? null,
      selectedFontCandidate: candidate.selectedFontId ?? null,
      selectedFontChanged:
        (baseline.selectedFontId ?? null) !==
        (candidate.selectedFontId ?? null),
      confidenceBaseline: baseline.confidence ?? null,
      confidenceCandidate: candidate.confidence ?? null,
      manualVerdict: null,
      manualNotes: "",
    });
  }
  return rows;
}

/** @param {Record<string, any>} report */
function summarizeRunDecisions(report) {
  const pages = Array.isArray(report.pages) ? report.pages : [];
  const completed = pages.filter((page) => page.status === "completed");
  const failed = pages.length - completed.length;
  const decisions = completed.flatMap((page) => page.fontDecisions || []);
  const applied = decisions.filter((decision) => Boolean(decision.applied));
  const selectedFonts = new Set(
    applied.map((decision) => decision.selectedFontId).filter(Boolean),
  );
  return {
    pages: pages.length,
    completedPages: completed.length,
    failedPages: failed,
    blocks: decisions.length,
    appliedBlocks: applied.length,
    automaticApplyRate: decisions.length
      ? applied.length / decisions.length
      : 0,
    meanAppliedConfidence: mean(
      applied
        .map((decision) => Number(decision.confidence))
        .filter(Number.isFinite),
    ),
    distinctSelectedFonts: selectedFonts.size,
    selectedFontCounts: countValues(
      applied.map((decision) => decision.selectedFontId),
    ),
    roleCounts: countValues(
      decisions.map((decision) => decision.role || "unknown"),
    ),
  };
}

/** @param {ReturnType<typeof summarizeRunDecisions>} baseline @param {ReturnType<typeof summarizeRunDecisions>} candidate @param {any[]} pages */
function buildGuardrails(baseline, candidate, pages) {
  const failures = [];
  if (candidate.completedPages < baseline.completedPages) {
    failures.push("candidate_completed_fewer_pages");
  }
  if (candidate.failedPages > baseline.failedPages) {
    failures.push("candidate_failed_more_pages");
  }
  if (candidate.blocks !== baseline.blocks) {
    failures.push("translated_block_count_changed");
  }
  if (pages.some((page) => page.status !== "paired")) {
    failures.push("cohort_page_pairing_incomplete");
  }
  if (candidate.automaticApplyRate + 0.05 < baseline.automaticApplyRate) {
    failures.push("automatic_apply_rate_dropped_over_5pp");
  }
  return {
    passed: failures.length === 0,
    failures,
    note: "Passing structural guardrails does not accept a model; inspect rendered pairs and complete manualVerdict fields.",
  };
}

/** @param {number[]} values */
function mean(values) {
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : 0;
}

/** @param {any[]} values */
function countValues(values) {
  const counts = {};
  for (const value of values) {
    const key = String(value || "unknown");
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/** @param {ReturnType<typeof compareRuns> extends Promise<infer T> ? T : never} report */
function buildComparisonMarkdown(report) {
  return [
    "# Library full-pipeline font QA comparison",
    "",
    `- Cohort: ${report.cohort}`,
    `- Baseline: ${report.baseline.candidateId} (${report.baseline.runId})`,
    `- Candidate: ${report.candidate.candidateId} (${report.candidate.runId})`,
    `- Completed pages: ${report.baseline.completedPages} → ${report.candidate.completedPages}`,
    `- Automatic apply rate: ${formatPercent(report.baseline.automaticApplyRate)} → ${formatPercent(report.candidate.automaticApplyRate)}`,
    `- Selected font diversity: ${report.baseline.distinctSelectedFonts} → ${report.candidate.distinctSelectedFonts}`,
    `- Structural guardrails: ${report.guardrails.passed ? "PASS" : "FAIL"}`,
    `- Review status: ${report.reviewStatus}`,
    "",
    "The structural result never replaces visual review. Compare every rendered page pair, then fill the block-level manualVerdict fields in comparison.json.",
    "",
  ].join("\n");
}

/** @param {number} value */
function formatPercent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

module.exports = {
  buildComparisonMarkdown,
  compareRuns,
  summarizeRunDecisions,
};
