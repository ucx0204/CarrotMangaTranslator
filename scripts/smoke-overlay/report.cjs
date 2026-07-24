const { writeFile } = require("node:fs/promises");
const path = require("node:path");

/**
 * @typedef {{ pattern: number; other: number }} BlockTypeCounts
 * @typedef {{ filePath: string; groupKey: string; hash: number }} SmokeSample
 * @typedef {{ index: number; sample: SmokeSample; geometryPath: string; overlayPath: string; blockCount: number; typeCounts: BlockTypeCounts; elapsedMs: number }} RenderedSmokeItem
 * @typedef {{ sample: SmokeSample; message: string; status?: unknown; statusText?: unknown; rawTextPreview?: unknown; requestSummary?: unknown }} SkippedSmokeItem
 * @typedef {{ modelProvider?: string; gemmaVramMode?: unknown; modelRepo?: unknown; modelFile?: unknown; mmprojRepo?: unknown; mmprojFile?: unknown; ctx?: unknown; batch?: unknown; ubatch?: unknown; kvOffload?: unknown; mmprojOffload?: unknown; fitTargetMb?: unknown; useDraft?: unknown; imageMinTokens?: unknown; imageMaxTokens?: unknown; [key: string]: unknown }} SmokeOptions
 */

/**
 * @param {string} outDir
 * @param {RenderedSmokeItem[]} rendered
 * @param {SkippedSmokeItem[]} skipped
 * @param {string} geometrySheetPath
 * @param {string} overlaySheetPath
 * @param {SmokeOptions} baseOptions
 * @param {number} elapsedMs
 */
async function writeReport(
  outDir,
  rendered,
  skipped,
  geometrySheetPath,
  overlaySheetPath,
  baseOptions,
  elapsedMs,
) {
  const lines = [
    ...buildSummary(
      rendered,
      skipped,
      geometrySheetPath,
      overlaySheetPath,
      baseOptions,
      elapsedMs,
    ),
    ...buildChecklist(),
    "## Samples",
    "",
    ...rendered.flatMap((item) => [
      `- ${item.index}. blocks=${item.blockCount} pattern=${item.typeCounts?.pattern ?? 0} elapsed=${formatDuration(item.elapsedMs)} ${item.sample.filePath}`,
      `  - geometry: ${item.geometryPath}`,
      `  - overlay: ${item.overlayPath}`,
    ]),
  ];
  await writeFile(
    path.join(outDir, "report.md"),
    `${lines.join("\n")}\n`,
    "utf8",
  );
}

/** @param {RenderedSmokeItem[]} rendered @param {SkippedSmokeItem[]} skipped @param {string} geometrySheetPath @param {string} overlaySheetPath @param {SmokeOptions} options @param {number} elapsedMs */
function buildSummary(
  rendered,
  skipped,
  geometrySheetPath,
  overlaySheetPath,
  options,
  elapsedMs,
) {
  const counts = rendered.reduce(
    (total, item) => ({
      pattern: total.pattern + (item.typeCounts?.pattern ?? 0),
      other: total.other + (item.typeCounts?.other ?? 0),
    }),
    { pattern: 0, other: 0 },
  );
  return [
    "# Overlay Smoke Test",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Provider: ${options.modelProvider}`,
    `- Samples: ${rendered.length}`,
    `- Skipped candidates: ${skipped.length}`,
    `- Elapsed: ${formatDuration(elapsedMs)}`,
    `- Gemma mode: ${options.gemmaVramMode ?? ""}`,
    `- Model: ${options.modelRepo ?? ""} / ${options.modelFile ?? ""}`,
    `- MMProj: ${options.mmprojRepo ?? ""} / ${options.mmprojFile ?? ""}`,
    `- Runtime: ctx ${options.ctx ?? ""}, batch ${options.batch ?? ""}, ubatch ${options.ubatch ?? ""}, image tokens ${options.imageMinTokens ?? ""}-${options.imageMaxTokens ?? ""}`,
    `- Runtime flags: kvOffload=${String(options.kvOffload)}, mmprojOffload=${String(options.mmprojOffload)}, useDraft=${String(options.useDraft)}, fitTargetMb=${String(options.fitTargetMb ?? "")}`,
    `- Type counts: pattern ${counts.pattern}, other ${counts.other}`,
    ...(geometrySheetPath ? [`- Geometry sheet: ${geometrySheetPath}`] : []),
    ...(overlaySheetPath ? [`- Overlay sheet: ${overlaySheetPath}`] : []),
    "- Source filter: original jpg/jpeg/png pages only; translated_images, mask, inpainted, translated outputs are excluded.",
    "",
  ];
}

function buildChecklist() {
  return [
    "## Manual QA checklist",
    "",
    "- Geometry PNG: bbox tightly covers the original Japanese glyph ink.",
    "- Overlay PNG: Korean overlay stays near the source position and preserves source scale where possible.",
    "- No bottom clipping in overlay PNG.",
    "- Neighboring speech bubbles stay separate.",
    "- Non-dialogue slanted text keeps a useful angle.",
    "",
  ];
}

/** @param {number} ms */
function formatDuration(ms) {
  const safeMs = Math.max(0, Number(ms) || 0);
  if (safeMs < 1000) return `${Math.round(safeMs)}ms`;
  const seconds = safeMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds - minutes * 60).toFixed(1)}s`;
}

module.exports = { formatDuration, writeReport };
