/* eslint-disable @typescript-eslint/ban-ts-comment, complexity, max-lines, max-lines-per-function -- standalone immutable diagnostic sealer */
// @ts-nocheck -- offline artifact reader with versioned runtime JSON inputs.
"use strict";

const { createHash } = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

const SCHEMA_VERSION =
  "manga-font-page-relative-role-training-only-diagnostic-v1";
const DIALOGUE_ROLE = "dialogue";
const EMPHASIS_ROLE = "emphasis_dialogue";
const DEFAULTS = Object.freeze({
  labelsDir: path.resolve(
    "artifacts/manga-font-v2-baseline40-r3h-r4a25-development-correction-training-only-r2-adjudicated",
  ),
  baselineRun: path.resolve(
    "artifacts/library-full-pipeline-font-qa-v9/runs/baseline40/r3h-eval-v1/replay-20260811-r3",
  ),
  candidateRun: path.resolve(
    "artifacts/library-full-pipeline-font-qa-v9/runs/baseline40/r3h-page-relative-role-qa-v1/baseline40-20260811-r1",
  ),
  output: path.resolve(
    "artifacts/manga-font-v2-page-relative-role-training-only-diagnostic-20260811-r1-sealed",
  ),
});

const REQUIRED_SOURCE_AUTHORITY = Object.freeze({
  development_only: true,
  training_only: true,
  human_gold: false,
  evaluation_eligible: false,
  automatic_release_authority: false,
});
const EXPECTED_SEALED_RESULT = Object.freeze({
  labelRows: 94,
  exactJoinedRows: 93,
  correctedNormals: 5,
  falseNormalizations: 0,
  missedNormals: 28,
  missedEmphasis: 8,
});

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizePath(value) {
  return path.relative(process.cwd(), value).replaceAll("\\", "/");
}

function expectedRoleForIntent(intent) {
  if (intent === "normal") return DIALOGUE_ROLE;
  if (intent === "emphasis") return EMPHASIS_ROLE;
  throw new Error(`Unsupported visual_intent: ${intent}`);
}

function blockIndexFromId(blockId) {
  const match = /-block-(\d+)$/.exec(String(blockId));
  if (!match) throw new Error(`Invalid block id: ${blockId}`);
  const index = Number(match[1]) - 1;
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Invalid one-based block suffix: ${blockId}`);
  }
  return index;
}

function joinKey(pageId, blockIndex) {
  return `${pageId}|${blockIndex}`;
}

function roleProbability(inference, role) {
  const prediction = asRecord(inference?.rolePrediction);
  if (prediction.primary === role) {
    return finiteNumber(prediction.confidence);
  }
  const alternative = Array.isArray(prediction.alternatives)
    ? prediction.alternatives.find((entry) => entry?.role === role)
    : null;
  return finiteNumber(alternative?.confidence);
}

function assertDevelopmentOnlyAuthority(authority, source) {
  const value = asRecord(authority);
  for (const [key, expected] of Object.entries(REQUIRED_SOURCE_AUTHORITY)) {
    if (value[key] !== expected) {
      throw new Error(
        `${source} authority ${key} must be ${expected}, got ${value[key]}`,
      );
    }
  }
}

function validateLabelAuthority(labels, actionableCorrections) {
  if (!Array.isArray(labels) || labels.length === 0) {
    throw new Error("Training-only labels are empty.");
  }
  for (const label of labels) {
    assertDevelopmentOnlyAuthority(
      label?.authority,
      `label ${label?.review_id ?? "unknown"}`,
    );
    const expectedRole = expectedRoleForIntent(label.visual_intent);
    if (label.role !== expectedRole) {
      throw new Error(
        `Label ${label.review_id} role ${label.role} conflicts with visual_intent ${label.visual_intent}.`,
      );
    }
  }
  assertDevelopmentOnlyAuthority(
    actionableCorrections?.authority,
    "actionable-corrections.json",
  );
}

/** Build a strict index from already parsed page traces. Exported for tests. */
function buildRunIndex(pages, runName = "run") {
  const pixelByKey = new Map();
  const requestByKey = new Map();
  const pageIds = new Set();
  let pixelRowCount = 0;
  let requestRowCount = 0;
  for (const page of pages) {
    const pageNumber = Number(page.pageNumber);
    const trace = asRecord(page.trace);
    if (!Number.isInteger(pageNumber) || pageNumber <= 0) {
      throw new Error(`${runName} has invalid page number: ${page.pageNumber}`);
    }
    if (!Array.isArray(trace.requestBlocks)) {
      throw new Error(`${runName} page ${pageNumber} requestBlocks missing.`);
    }
    if (!Array.isArray(trace.pixelInference)) {
      throw new Error(`${runName} page ${pageNumber} pixelInference missing.`);
    }
    const requestByBlockId = new Map();
    for (const request of trace.requestBlocks) {
      const blockId = String(request?.blockId ?? "");
      const blockIndex = blockIndexFromId(blockId);
      const pageId = blockId.split("-font-qa-")[0];
      const key = joinKey(pageId, blockIndex);
      if (requestByKey.has(key) || requestByBlockId.has(blockId)) {
        throw new Error(`${runName} duplicate request key: ${key}`);
      }
      const row = { pageNumber, pageId, blockIndex, blockId, request };
      requestByKey.set(key, row);
      requestByBlockId.set(blockId, row);
      requestRowCount += 1;
    }
    for (const inference of trace.pixelInference) {
      const blockId = String(inference?.blockId ?? "");
      const request = requestByBlockId.get(blockId);
      if (!request) {
        throw new Error(
          `${runName} inference has no matching request row: ${blockId}`,
        );
      }
      const pageId = String(inference?.pageId ?? "");
      if (pageId !== request.pageId) {
        throw new Error(
          `${runName} page id mismatch for ${blockId}: ${pageId} vs ${request.pageId}`,
        );
      }
      const key = joinKey(pageId, request.blockIndex);
      if (pixelByKey.has(key)) {
        throw new Error(`${runName} duplicate pixel key: ${key}`);
      }
      pixelByKey.set(key, { ...request, inference });
      pixelRowCount += 1;
      pageIds.add(pageId);
    }
  }
  return {
    runName,
    pageCount: pages.length,
    pageIdCount: pageIds.size,
    requestRowCount,
    pixelRowCount,
    requestByKey,
    pixelByKey,
  };
}

function classifyRow(expectedRole, baselineRole, projectedRole) {
  if (
    expectedRole === DIALOGUE_ROLE &&
    baselineRole === EMPHASIS_ROLE &&
    projectedRole === DIALOGUE_ROLE
  ) {
    return "corrected_normal";
  }
  if (
    expectedRole === EMPHASIS_ROLE &&
    baselineRole === EMPHASIS_ROLE &&
    projectedRole === DIALOGUE_ROLE
  ) {
    return "false_normalization";
  }
  if (expectedRole === DIALOGUE_ROLE && projectedRole === EMPHASIS_ROLE) {
    return "missed_normal";
  }
  if (expectedRole === EMPHASIS_ROLE && projectedRole === DIALOGUE_ROLE) {
    return "missed_emphasis";
  }
  return expectedRole === DIALOGUE_ROLE ? "correct_normal" : "correct_emphasis";
}

function rawFeatures(row) {
  const inference = row.baselineInference;
  const morphology = asRecord(inference.glyphMorphology);
  const bbox = asRecord(row.requestItem.bbox);
  const width = finiteNumber(bbox.w);
  const height = finiteNumber(bbox.h);
  return {
    dialogueProbability: roleProbability(inference, DIALOGUE_ROLE),
    emphasisProbability: roleProbability(inference, EMPHASIS_ROLE),
    globalForegroundDistanceMean: finiteNumber(
      morphology.globalForegroundDistanceMean,
    ),
    medianComponentDistanceMean: finiteNumber(
      morphology.medianComponentDistanceMean,
    ),
    medianComponentFill: finiteNumber(morphology.medianComponentFill),
    foregroundMeanLuma: finiteNumber(morphology.foregroundMeanLuma),
    connectedComponentCount: finiteNumber(morphology.connectedComponentCount),
    longEdge: Math.max(width, height),
    shortEdge: Math.min(width, height),
    candidateCount: Array.isArray(row.requestItem.candidateIds)
      ? row.requestItem.candidateIds.length
      : 0,
  };
}

function emptyConfusion() {
  return {
    normal: { dialogue: 0, emphasis_dialogue: 0 },
    emphasis: { dialogue: 0, emphasis_dialogue: 0 },
  };
}

function addConfusion(confusion, intent, role) {
  if (
    !Object.hasOwn(confusion, intent) ||
    !Object.hasOwn(confusion[intent], role)
  ) {
    throw new Error(`Unsupported confusion cell: ${intent}/${role}`);
  }
  confusion[intent][role] += 1;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function quantile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return round(sorted[lower], 6);
  return round(
    sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower),
    6,
  );
}

function featureQuartiles(rows, field) {
  const values = rows
    .map((row) => finiteNumber(row.rawFeatures[field], Number.NaN))
    .filter(Number.isFinite);
  return {
    p25: quantile(values, 0.25),
    median: quantile(values, 0.5),
    p75: quantile(values, 0.75),
  };
}

function groupCount(rows, selector) {
  const counts = new Map();
  for (const row of rows) {
    const key = String(selector(row));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) =>
      left.localeCompare(right, "en"),
    ),
  );
}

function pageCount(rows) {
  return Object.fromEntries(
    [
      ...rows.reduce((counts, row) => {
        counts.set(row.pageNumber, (counts.get(row.pageNumber) ?? 0) + 1);
        return counts;
      }, new Map()),
    ].sort(([left], [right]) => left - right),
  );
}

function summarizeRows(rows) {
  const baselineCorrect = rows.filter(
    (row) => row.baselineRole === row.expectedRole,
  ).length;
  const projectedCorrect = rows.filter(
    (row) => row.projectedRole === row.expectedRole,
  ).length;
  return {
    rows: rows.length,
    baselineCorrect,
    projectedCorrect,
    baselineAccuracy: round(baselineCorrect / Math.max(1, rows.length), 6),
    projectedAccuracy: round(projectedCorrect / Math.max(1, rows.length), 6),
    accuracyDelta: round(
      (projectedCorrect - baselineCorrect) / Math.max(1, rows.length),
      6,
    ),
    correctedNormals: rows.filter((row) => row.cohort === "corrected_normal")
      .length,
    falseNormalizations: rows.filter(
      (row) => row.cohort === "false_normalization",
    ).length,
    missedNormals: rows.filter((row) => row.cohort === "missed_normal").length,
    missedEmphasis: rows.filter((row) => row.cohort === "missed_emphasis")
      .length,
  };
}

function summarizeSlices(rows, selector) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(selector(row));
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, group]) => [key, summarizeRows(group)]),
  );
}

function compactRecord(row) {
  return {
    pageNumber: row.pageNumber,
    reviewId: row.reviewId,
    sourcePageId: row.sourcePageId,
    blockIndex: row.blockIndex,
    blockId: row.blockId,
    sourceText: row.sourceText,
    visualIntent: row.visualIntent,
    expectedRole: row.expectedRole,
    baselineRole: row.baselineRole,
    projectedRole: row.projectedRole,
    roleCorrection: row.roleCorrection,
    pageConsistencyIntent: row.pageConsistencyIntent,
    requestTextRole: row.requestTextRole,
    requestFontRole: row.requestFontRole,
    qaStatus: row.qaStatus,
    qaReasonCodes: row.qaReasonCodes,
    cohort: row.cohort,
    rawFeatures: row.rawFeatures,
  };
}

function buildDiagnosticAnalysis({
  labels,
  actionableCorrections,
  baselineIndex,
  candidateIndex,
}) {
  validateLabelAuthority(labels, actionableCorrections);
  const joined = [];
  const exclusions = [];
  const seenLabelKeys = new Set();
  for (const label of labels) {
    const identity = asRecord(label.identity);
    const sourcePageId = String(identity.source_page_id ?? "");
    const blockIndex = Number(identity.block_index);
    const key = joinKey(sourcePageId, blockIndex);
    if (seenLabelKeys.has(key)) {
      throw new Error(`Duplicate label join key: ${key}`);
    }
    seenLabelKeys.add(key);
    const baseline = baselineIndex.pixelByKey.get(key);
    const candidate = candidateIndex.pixelByKey.get(key);
    if (!baseline || !candidate) {
      const baselineRequest = baselineIndex.requestByKey.get(key);
      const candidateRequest = candidateIndex.requestByKey.get(key);
      exclusions.push({
        reviewId: label.review_id,
        sourcePageId,
        blockIndex,
        blockId: identity.block_id,
        sourceText: label.source_text,
        visualIntent: label.visual_intent,
        expectedRole: label.role,
        reason:
          baselineRequest && candidateRequest
            ? "request_present_but_not_pixel_role_eligible_in_both_runs"
            : "missing_run_join_key",
        baselineRequestTextRole:
          baselineRequest?.request?.item?.textRole ?? null,
        baselineRequestFontRole:
          baselineRequest?.request?.item?.fontRole ?? null,
        candidateRequestTextRole:
          candidateRequest?.request?.item?.textRole ?? null,
        candidateRequestFontRole:
          candidateRequest?.request?.item?.fontRole ?? null,
      });
      continue;
    }
    if (
      baseline.blockId !== identity.block_id ||
      candidate.blockId !== identity.block_id
    ) {
      throw new Error(`Exact block identity mismatch for ${key}`);
    }
    const baselineRole = String(
      baseline.inference?.rolePrediction?.primary ?? "",
    );
    const qa = asRecord(candidate.inference?.pageRelativeRoleQa);
    const projectedRole = String(
      qa.projectedRole ?? candidate.inference?.rolePrediction?.primary ?? "",
    );
    if (
      ![DIALOGUE_ROLE, EMPHASIS_ROLE].includes(baselineRole) ||
      ![DIALOGUE_ROLE, EMPHASIS_ROLE].includes(projectedRole)
    ) {
      throw new Error(
        `Unsupported joined role for ${key}: ${baselineRole}/${projectedRole}`,
      );
    }
    const requestItem = asRecord(baseline.request?.item);
    const row = {
      pageNumber: baseline.pageNumber,
      reviewId: label.review_id,
      sourcePageId,
      blockIndex,
      blockId: identity.block_id,
      sourceText: label.source_text,
      visualIntent: label.visual_intent,
      expectedRole: label.role,
      baselineRole,
      projectedRole,
      roleCorrection: Boolean(label.role_correction),
      pageConsistencyIntent: label.page_consistency_intent,
      selectionReason: label.selection_reason,
      requestTextRole: requestItem.textRole ?? null,
      requestFontRole: requestItem.fontRole ?? null,
      direction: requestItem.direction ?? null,
      distortion: baseline.inference?.treatment?.distortion ?? null,
      qaStatus: qa.status ?? null,
      qaReasonCodes: Array.isArray(qa.reasonCodes) ? qa.reasonCodes : [],
      requestItem,
      baselineInference: baseline.inference,
    };
    row.cohort = classifyRow(
      row.expectedRole,
      row.baselineRole,
      row.projectedRole,
    );
    row.rawFeatures = rawFeatures(row);
    joined.push(row);
  }

  const baselineConfusion = emptyConfusion();
  const projectedConfusion = emptyConfusion();
  for (const row of joined) {
    addConfusion(baselineConfusion, row.visualIntent, row.baselineRole);
    addConfusion(projectedConfusion, row.visualIntent, row.projectedRole);
  }
  const byCohort = Object.fromEntries(
    [
      "correct_normal",
      "corrected_normal",
      "missed_normal",
      "correct_emphasis",
      "false_normalization",
      "missed_emphasis",
    ].map((cohort) => [cohort, joined.filter((row) => row.cohort === cohort)]),
  );
  const rawFeatureFields = [
    "dialogueProbability",
    "globalForegroundDistanceMean",
    "medianComponentDistanceMean",
    "medianComponentFill",
    "foregroundMeanLuma",
    "connectedComponentCount",
    "longEdge",
    "shortEdge",
    "candidateCount",
  ];
  const rawFeatureCohorts = Object.fromEntries(
    Object.entries(byCohort)
      .filter(([, rows]) => rows.length > 0)
      .map(([cohort, rows]) => [
        cohort,
        {
          rows: rows.length,
          ...Object.fromEntries(
            rawFeatureFields.map((field) => [
              field,
              featureQuartiles(rows, field),
            ]),
          ),
        },
      ]),
  );
  const correctedNormals = byCohort.corrected_normal;
  const falseNormalizations = byCohort.false_normalization;
  const missedNormals = byCohort.missed_normal;
  const missedEmphasis = byCohort.missed_emphasis;

  return {
    join: {
      labelRows: labels.length,
      exactJoinedRows: joined.length,
      excludedRows: exclusions.length,
      baseline: {
        pages: baselineIndex.pageCount,
        requestRows: baselineIndex.requestRowCount,
        pixelRows: baselineIndex.pixelRowCount,
      },
      candidate: {
        pages: candidateIndex.pageCount,
        requestRows: candidateIndex.requestRowCount,
        pixelRows: candidateIndex.pixelRowCount,
      },
      exclusions,
    },
    confusion: {
      baseline: baselineConfusion,
      projected: projectedConfusion,
    },
    overall: summarizeRows(joined),
    events: {
      changedJoinedRows: joined.filter(
        (row) => row.baselineRole !== row.projectedRole,
      ).length,
      correctedNormals: correctedNormals.length,
      falseNormalizations: falseNormalizations.length,
      missedNormals: missedNormals.length,
      missedEmphasis: missedEmphasis.length,
      preservedCorrectEmphasis: byCohort.correct_emphasis.length,
      correctedNormalRecords: correctedNormals.map(compactRecord),
      falseNormalizationRecords: falseNormalizations.map(compactRecord),
      missedNormalPageCounts: pageCount(missedNormals),
      missedEmphasisPageCounts: pageCount(missedEmphasis),
    },
    slices: {
      roleCorrection: summarizeSlices(joined, (row) => row.roleCorrection),
      pageConsistencyIntent: summarizeSlices(
        joined,
        (row) => row.pageConsistencyIntent,
      ),
      selectionReason: summarizeSlices(joined, (row) => row.selectionReason),
      requestTextRole: summarizeSlices(joined, (row) => row.requestTextRole),
      requestFontRole: summarizeSlices(joined, (row) => row.requestFontRole),
      missedNormalDirection: groupCount(missedNormals, (row) => row.direction),
      missedNormalDistortion: groupCount(
        missedNormals,
        (row) => row.distortion,
      ),
      rawFeatureCohorts,
    },
    anchorRecords: joined
      .filter((row) => row.pageNumber === 35 || row.pageNumber === 38)
      .sort(
        (left, right) =>
          left.pageNumber - right.pageNumber ||
          left.blockIndex - right.blockIndex,
      )
      .map(compactRecord),
  };
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

async function readJsonl(file) {
  const text = await fsp.readFile(file, "utf8");
  return text
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${file}:${index + 1}: ${error.message}`, {
          cause: error,
        });
      }
    });
}

async function fileInventory(file, base = process.cwd()) {
  const bytes = await fsp.readFile(file);
  const stats = await fsp.stat(file);
  return {
    path: path.relative(base, file).replaceAll("\\", "/"),
    sha256: sha256(bytes),
    size: stats.size,
  };
}

async function loadRun(runRoot, runName) {
  const pagesRoot = path.join(runRoot, "pages");
  const entries = (await fsp.readdir(pagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
    .sort((left, right) => Number(left.name) - Number(right.name));
  const pages = [];
  const files = [];
  for (const entry of entries) {
    const file = path.join(pagesRoot, entry.name, "font-inference.json");
    pages.push({ pageNumber: Number(entry.name), trace: await readJson(file) });
    files.push(await fileInventory(file, runRoot));
  }
  for (const name of ["run-config.json", "run-report.json"]) {
    const file = path.join(runRoot, name);
    try {
      files.push(await fileInventory(file, runRoot));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    index: buildRunIndex(pages, runName),
    inventory: {
      root: normalizePath(runRoot),
      files,
      aggregateSha256: sha256(JSON.stringify(files)),
    },
  };
}

function formatPercent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function buildMarkdown(report) {
  const analysis = report.analysis;
  const lines = [
    "# Training-only page-relative role diagnostic",
    "",
    "> Development diagnostic only. This is not human gold, evaluation authority, release authority, a font-ranking judgment, or a threshold/release recommendation.",
    "",
    `- Schema: ${report.schemaVersion}`,
    `- Labels: ${analysis.join.exactJoinedRows}/${analysis.join.labelRows} exact pixel-role joins; ${analysis.join.excludedRows} excluded`,
    `- Accuracy: ${analysis.overall.baselineCorrect}/${analysis.overall.rows} (${formatPercent(analysis.overall.baselineAccuracy)}) → ${analysis.overall.projectedCorrect}/${analysis.overall.rows} (${formatPercent(analysis.overall.projectedAccuracy)})`,
    `- Corrected normals: ${analysis.events.correctedNormals}`,
    `- False normalizations: ${analysis.events.falseNormalizations}`,
    `- Missed normals: ${analysis.events.missedNormals}`,
    `- Missed emphasis: ${analysis.events.missedEmphasis}`,
    "",
    "## Confusion",
    "",
    "| Expected intent | Baseline dialogue | Baseline emphasis | Projected dialogue | Projected emphasis |",
    "| --- | ---: | ---: | ---: | ---: |",
    `| normal | ${analysis.confusion.baseline.normal.dialogue} | ${analysis.confusion.baseline.normal.emphasis_dialogue} | ${analysis.confusion.projected.normal.dialogue} | ${analysis.confusion.projected.normal.emphasis_dialogue} |`,
    `| emphasis | ${analysis.confusion.baseline.emphasis.dialogue} | ${analysis.confusion.baseline.emphasis.emphasis_dialogue} | ${analysis.confusion.projected.emphasis.dialogue} | ${analysis.confusion.projected.emphasis.emphasis_dialogue} |`,
    "",
    "## Join exclusion",
    "",
  ];
  for (const row of analysis.join.exclusions) {
    lines.push(
      `- ${row.reviewId}: ${row.reason}; request=${row.baselineRequestTextRole}/${row.baselineRequestFontRole}; source=${JSON.stringify(row.sourceText)}`,
    );
  }
  lines.push(
    "",
    "## Page 35 / 38 anchors",
    "",
    "| Page | Review | Block | Intent | Baseline | Projected | Cohort | Source |",
    "| ---: | --- | ---: | --- | --- | --- | --- | --- |",
  );
  for (const row of analysis.anchorRecords) {
    lines.push(
      `| ${row.pageNumber} | ${row.reviewId} | ${row.blockIndex} | ${row.visualIntent} | ${row.baselineRole} | ${row.projectedRole} | ${row.cohort} | ${String(row.sourceText).replaceAll("|", "\\|")} |`,
    );
  }
  lines.push(
    "",
    "## Input seals",
    "",
    `- training-labels.jsonl: ${report.inputs.trainingLabels.sha256}`,
    `- actionable-corrections.json: ${report.inputs.actionableCorrections.sha256}`,
    `- baseline run aggregate: ${report.inputs.baselineRun.aggregateSha256}`,
    `- candidate run aggregate: ${report.inputs.candidateRun.aggregateSha256}`,
    `- producer script: ${report.producer.sha256}`,
    "",
    "## Recommendation boundary",
    "",
    "No threshold recommendation and no release recommendation are made. Font candidate preferences in the source corrections were intentionally ignored.",
    "",
  );
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(`Invalid argument: ${key}`);
    }
    index += 1;
    if (key === "--labels-dir") options.labelsDir = path.resolve(value);
    else if (key === "--baseline-run")
      options.baselineRun = path.resolve(value);
    else if (key === "--candidate-run")
      options.candidateRun = path.resolve(value);
    else if (key === "--output") options.output = path.resolve(value);
    else throw new Error(`Unknown argument: ${key}`);
  }
  return options;
}

async function runDiagnostic(options = DEFAULTS) {
  const labelsFile = path.join(options.labelsDir, "training-labels.jsonl");
  const actionableFile = path.join(
    options.labelsDir,
    "actionable-corrections.json",
  );
  const [labels, actionableCorrections, baseline, candidate] =
    await Promise.all([
      readJsonl(labelsFile),
      readJson(actionableFile),
      loadRun(options.baselineRun, "baseline"),
      loadRun(options.candidateRun, "candidate"),
    ]);
  const [trainingLabelsInput, actionableInput, producerInput] =
    await Promise.all([
      fileInventory(labelsFile),
      fileInventory(actionableFile),
      fileInventory(__filename),
    ]);
  trainingLabelsInput.rowCount = labels.length;
  const analysis = buildDiagnosticAnalysis({
    labels,
    actionableCorrections,
    baselineIndex: baseline.index,
    candidateIndex: candidate.index,
  });
  const observedContract = {
    labelRows: analysis.join.labelRows,
    exactJoinedRows: analysis.join.exactJoinedRows,
    correctedNormals: analysis.events.correctedNormals,
    falseNormalizations: analysis.events.falseNormalizations,
    missedNormals: analysis.events.missedNormals,
    missedEmphasis: analysis.events.missedEmphasis,
  };
  if (
    JSON.stringify(observedContract) !== JSON.stringify(EXPECTED_SEALED_RESULT)
  ) {
    throw new Error(
      `Diagnostic result contract mismatch: ${JSON.stringify(observedContract)}`,
    );
  }
  const generatedAt = new Date().toISOString();
  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    authority: {
      developmentOnly: true,
      trainingOnly: true,
      humanGold: false,
      evaluationEligible: false,
      releaseEligible: false,
      automaticReleaseAuthority: false,
      fontRankingUseAllowed: false,
      thresholdRecommendationAllowed: false,
      releaseRecommendationAllowed: false,
      scope: "role_direction_diagnostic_only",
    },
    producer: producerInput,
    inputs: {
      trainingLabels: trainingLabelsInput,
      actionableCorrections: {
        ...actionableInput,
        roleCorrectionsDeclared:
          actionableCorrections?.counts?.role_corrections ?? null,
        fontCandidateFieldsUsed: false,
      },
      baselineRun: baseline.inventory,
      candidateRun: candidate.inventory,
    },
    analysis,
    recommendations: {
      threshold: null,
      release: null,
      statement:
        "No threshold or release recommendation. Development-only labels cannot authorize evaluation or promotion.",
    },
  };

  try {
    await fsp.mkdir(options.output, { recursive: false });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(
        `Refusing to overwrite existing artifact: ${options.output}`,
        { cause: error },
      );
    }
    throw error;
  }
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  const markdownBytes = Buffer.from(`${buildMarkdown(report)}\n`);
  const outputFiles = {
    "report.json": sha256(reportBytes),
    "report.md": sha256(markdownBytes),
  };
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    artifactId: path.basename(options.output),
    generatedAt,
    authority: report.authority,
    inputSha256: {
      trainingLabels: trainingLabelsInput.sha256,
      actionableCorrections: actionableInput.sha256,
      baselineRunAggregate: baseline.inventory.aggregateSha256,
      candidateRunAggregate: candidate.inventory.aggregateSha256,
      producer: producerInput.sha256,
    },
    resultContract: {
      ...EXPECTED_SEALED_RESULT,
      exactJoin: `${EXPECTED_SEALED_RESULT.exactJoinedRows}/${EXPECTED_SEALED_RESULT.labelRows}`,
      thresholdRecommendation: null,
      releaseRecommendation: null,
    },
    outputFiles: { ...outputFiles },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  outputFiles["manifest.json"] = sha256(manifestBytes);
  const sums = {
    schemaVersion: 1,
    files: outputFiles,
    recordSha256: sha256(JSON.stringify(outputFiles)),
  };
  await Promise.all([
    fsp.writeFile(path.join(options.output, "report.json"), reportBytes),
    fsp.writeFile(path.join(options.output, "report.md"), markdownBytes),
    fsp.writeFile(path.join(options.output, "manifest.json"), manifestBytes),
    fsp.writeFile(
      path.join(options.output, "SHA256SUMS.json"),
      `${JSON.stringify(sums, null, 2)}\n`,
      "utf8",
    ),
  ]);
  return { report, manifest, sums, output: options.output };
}

async function main() {
  const result = await runDiagnostic(parseArgs(process.argv.slice(2)));
  process.stdout.write(
    `${JSON.stringify(
      {
        output: result.output,
        exactJoin: `${result.report.analysis.join.exactJoinedRows}/${result.report.analysis.join.labelRows}`,
        correctedNormals: result.report.analysis.events.correctedNormals,
        falseNormalizations: result.report.analysis.events.falseNormalizations,
        missedNormals: result.report.analysis.events.missedNormals,
        missedEmphasis: result.report.analysis.events.missedEmphasis,
        reportSha256: result.sums.files["report.json"],
      },
      null,
      2,
    )}\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULTS,
  REQUIRED_SOURCE_AUTHORITY,
  buildDiagnosticAnalysis,
  buildRunIndex,
  classifyRow,
  parseArgs,
  quantile,
  roleProbability,
  runDiagnostic,
  validateLabelAuthority,
};
