/**
 * @typedef {{ name: string; candidate: Record<string, unknown>; measured: MeasuredSummary }} ResultSummary
 * @typedef {{ measuredPageCount: number; meanWallMs: number | null; meanPromptTokensPerSecond: number | null; meanPredictedTokensPerSecond: number | null; peakProcessVramMb: number | null; peakGpuDeltaMb: number | null; peakGpuUsedMb: number | null; minBlockCount: number; maxBlockCount: number }} MeasuredSummary
 * @typedef {{ imageTokenClipped: boolean; lastCudaMemoryBreakdown: null | { selfMiB: number; modelMiB: number; contextMiB: number; computeMiB: number } }} ServerLogSummary
 * @typedef {{ name: string; candidate: Record<string, unknown>; failed?: boolean; serverLog?: ServerLogSummary & { path: string }; measured: MeasuredSummary }} BenchmarkResult
 * @typedef {{ baseline: ResultSummary | null; winner: ResultSummary | null; accepted: ResultSummary[]; rules?: { minWallImprovement: number; vramDeltaLimitMb: number } }} BenchmarkSummary
 * @typedef {{ minWallImprovement: number; vramDeltaLimitMb: number }} BenchmarkRules
 */

/** @param {BenchmarkRules} rules */
function createBenchmarkReporting(rules) {
  return {
    /** @param {BenchmarkSummary} summary @param {BenchmarkResult[]} results */
    buildMarkdownReport: (summary, results) =>
      buildMarkdownReport(summary, results, rules),
    /** @param {BenchmarkResult[]} results */
    summarizeResults: (results) => summarizeResults(results, rules),
  };
}

/** @param {BenchmarkResult[]} results @param {BenchmarkRules} rules */
function summarizeResults(results, rules) {
  const baseline =
    results.find((result) => result.name === "baseline-b1024-ub1024") ??
    results[0] ??
    null;
  if (!baseline) return { baseline: null, winner: null, accepted: [] };
  const accepted = results.filter((result) =>
    isAcceptedCandidate(result, baseline, rules),
  );
  const winner = pickWinner(accepted, baseline);
  return {
    baseline: pickSummary(baseline),
    winner: pickSummary(winner),
    accepted: accepted.map(pickSummary),
    rules,
  };
}

/**
 * @param {BenchmarkResult} result
 * @param {BenchmarkResult} baseline
 * @param {BenchmarkRules} rules
 */
function isAcceptedCandidate(result, baseline, rules) {
  if (result === baseline) return true;
  if (result.serverLog?.imageTokenClipped) return false;
  const baselineMinBlocks = Number(baseline.measured.minBlockCount);
  if (
    Number.isFinite(baselineMinBlocks) &&
    Number(result.measured.minBlockCount) < baselineMinBlocks
  ) {
    return false;
  }
  const baselineWall = Number(baseline.measured.meanWallMs);
  const candidateWall = Number(result.measured.meanWallMs);
  if (!isPositiveFinite(baselineWall) || !isPositiveFinite(candidateWall)) {
    return false;
  }
  const baselinePeak = peakMemory(baseline);
  const candidatePeak = peakMemory(result);
  if (
    baselinePeak > 0 &&
    candidatePeak > baselinePeak + rules.vramDeltaLimitMb
  ) {
    return false;
  }
  return candidateWall <= baselineWall * (1 - rules.minWallImprovement);
}

/** @param {number} value */
function isPositiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}

/** @param {BenchmarkResult} result */
function peakMemory(result) {
  return Number(
    result.measured.peakProcessVramMb ??
      result.measured.peakGpuDeltaMb ??
      result.measured.peakGpuUsedMb ??
      0,
  );
}

/** @param {BenchmarkResult[]} accepted @param {BenchmarkResult} baseline */
function pickWinner(accepted, baseline) {
  return (
    [...accepted].sort((left, right) => {
      const wallDelta =
        Number(left.measured.meanWallMs) - Number(right.measured.meanWallMs);
      return Math.abs(wallDelta) > 500
        ? wallDelta
        : peakMemory(left) - peakMemory(right);
    })[0] ?? baseline
  );
}

/** @param {BenchmarkResult} result @returns {ResultSummary} */
function pickSummary(result) {
  return {
    name: result.name,
    candidate: result.candidate,
    measured: result.measured,
  };
}

/**
 * @param {BenchmarkSummary} summary
 * @param {BenchmarkResult[]} results
 * @param {BenchmarkRules} rules
 */
function buildMarkdownReport(summary, results, rules) {
  const lines = buildReportHeader(summary, rules);
  for (const result of results) {
    lines.push(buildResultRow(result, summary.baseline));
  }
  lines.push("", "## Launch Args");
  for (const result of results) {
    lines.push(
      "",
      `### ${result.name}`,
      "```text",
      JSON.stringify(result.candidate),
      "```",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** @param {BenchmarkSummary} summary @param {BenchmarkRules} rules */
function buildReportHeader(summary, rules) {
  return [
    "# Gemma Economy Performance Benchmark",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Winner: ${summary.winner?.name ?? "none"}`,
    `- Baseline: ${summary.baseline?.name ?? "none"}`,
    `- Rule: >= ${(rules.minWallImprovement * 100).toFixed(1)}% mean wall improvement, <= +${rules.vramDeltaLimitMb} MiB peak VRAM`,
    "",
    "| Candidate | Mean wall ms | Prompt tok/s | Decode tok/s | Server self MiB | Context MiB | Compute MiB | Peak process VRAM MiB | Peak GPU delta MiB | Blocks | Flags |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
  ];
}

/** @param {BenchmarkResult} result @param {ResultSummary | null | undefined} baseline */
function buildResultRow(result, baseline) {
  const measured = result.measured;
  const memory = result.serverLog?.lastCudaMemoryBreakdown;
  return [
    result.name,
    formatNumber(measured.meanWallMs, 0),
    formatNumber(measured.meanPromptTokensPerSecond, 2),
    formatNumber(measured.meanPredictedTokensPerSecond, 2),
    memory?.selfMiB ?? "",
    memory?.contextMiB ?? "",
    memory?.computeMiB ?? "",
    measured.peakProcessVramMb ?? "",
    measured.peakGpuDeltaMb ?? "",
    `${measured.minBlockCount}-${measured.maxBlockCount}`,
    buildResultFlags(result, baseline),
  ].join(" | ");
}

/** @param {BenchmarkResult} result @param {ResultSummary | null | undefined} baseline */
function buildResultFlags(result, baseline) {
  /** @type {string[]} */
  const flags = [];
  if (result.serverLog?.imageTokenClipped) flags.push("image-token-clipped");
  const baselineMinBlocks = Number(baseline?.measured?.minBlockCount);
  if (
    Number.isFinite(baselineMinBlocks) &&
    Number(result.measured?.minBlockCount) < baselineMinBlocks
  ) {
    flags.push("block-count-regression");
  }
  if (result.failed) flags.push("failed");
  return flags.join(", ");
}

/** @param {unknown} value @param {number} digits */
function formatNumber(value, digits) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "";
}

module.exports = { createBenchmarkReporting };
