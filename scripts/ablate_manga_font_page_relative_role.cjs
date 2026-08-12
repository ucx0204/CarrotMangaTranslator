/* eslint-disable @typescript-eslint/ban-ts-comment, complexity, max-lines, max-lines-per-function -- isolated evaluator accepts sealed versioned QA records */
// @ts-nocheck -- this is an offline evaluator over immutable runtime JSON, not a production route.
const { createHash } = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { createJiti } = require("jiti");

const EMPHASIS_ROLE = "emphasis_dialogue";
const DIALOGUE_ROLE = "dialogue";
const SINGLE_DAY_FONT_ID = "single-day";
const KNOWN_BAD_PAGES = new Set([3, 5, 6, 13, 16, 28, 30, 32, 38]);
const KNOWN_IMPROVED_PAGES = new Set([4, 18, 22, 35]);
const MORPHOLOGY_CONTRACT_VERSION = "font-matching-glyph-morphology-v1";

const jiti = createJiti(__filename, { interopDefault: true });
const { buildAutomaticFontPageConsistencyPlan } = jiti(
  path.resolve(
    __dirname,
    "../src/main/pipeline/automaticFontMatchingV2PageConsistency.ts",
  ),
);
const {
  STABLE_BALLOON_BODY_FONT_IDS,
  STABLE_BALLOON_SANS_FONT_IDS,
  STABLE_BALLOON_SERIF_FONT_IDS,
} = jiti(
  path.resolve(
    __dirname,
    "../src/main/pipeline/automaticFontMatchingV2PageFamily.ts",
  ),
);

const DEFAULTS = Object.freeze({
  r3: path.resolve(
    "artifacts/library-full-pipeline-font-qa-v9/runs/baseline40/r3h-eval-v1/replay-20260811-r3",
  ),
  r4: path.resolve(
    "artifacts/library-full-pipeline-font-qa-v9/runs/baseline40/r4a25-eval-v1/baseline40-20260811-r1",
  ),
  validation: path.resolve(
    "artifacts/manga-font-student-v81-role-family-evaluation-production-r3h-v1",
  ),
  val33: path.resolve(
    "artifacts/manga-font-student-human-overlay-adjudicated-val33-v1/val-samples-adjudicated.jsonl",
  ),
  output: path.resolve(
    "artifacts/manga-font-v2-page-relative-role-ablation-r3h-r4a25-v1",
  ),
});

const POLICY = Object.freeze({
  name: "pixel-page-relative-ordinary-majority-v1",
  minimumStrongDialogueProbability: 0.62,
  minimumSeedCount: 2,
  minimumSelfAnchoredClusterSize: 4,
  minimumSelfAnchoredSubstantiveRows: 3,
  minimumDominantClusterShare: 0.5,
  minimumSelfAnchorMedianDialogueProbability: 0.1,
  maximumSelfAnchorMedianGlobalDistance: 1.7,
  maximumSelfAnchorMedianComponentDistance: 1.65,
  minimumSelfAnchorMedianForegroundLuma: 42,
  minimumRecoveryDialogueProbability: 0.025,
  morphologyScales: Object.freeze({
    globalDistance: 0.34,
    componentDistance: 0.42,
    componentFill: 0.24,
    foregroundLuma: 28,
  }),
  maximumCompleteLinkMorphologyDistance: 1,
  fragmentMaximumLongEdge: 100,
  fragmentMaximumComponentCount: 10,
  fragmentMaximumShortEdge: 60,
  transferMaximumRawRank: 3,
  splitPeerMaximumEdgeGap: 34,
  splitPeerMaximumCenterDistanceRatio: 1.75,
  minimumStrongVariantWinnerScore: 0.4,
  minimumStrongVariantBodyGap: 0.28,
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

function isValidMorphology(morphology) {
  const value = asRecord(morphology);
  return Boolean(
    value.contractVersion === MORPHOLOGY_CONTRACT_VERSION &&
    value.maskSource === "raw_grayscale_otsu_minority_area3" &&
    value.distanceTransform === "opencv_dist_l2_mask5" &&
    value.connectivity === 8 &&
    Number.isInteger(value.connectedComponentCount) &&
    [
      value.globalForegroundDistanceMean,
      value.medianComponentDistanceMean,
      value.medianComponentFill,
      value.foregroundMeanLuma,
    ].every(Number.isFinite),
  );
}

function morphologyDistance(left, right, policy = POLICY) {
  if (!isValidMorphology(left) || !isValidMorphology(right)) return Infinity;
  return Math.max(
    Math.abs(
      left.globalForegroundDistanceMean - right.globalForegroundDistanceMean,
    ) / policy.morphologyScales.globalDistance,
    Math.abs(
      left.medianComponentDistanceMean - right.medianComponentDistanceMean,
    ) / policy.morphologyScales.componentDistance,
    Math.abs(left.medianComponentFill - right.medianComponentFill) /
      policy.morphologyScales.componentFill,
    Math.abs(left.foregroundMeanLuma - right.foregroundMeanLuma) /
      policy.morphologyScales.foregroundLuma,
  );
}

function compareStrings(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function completeLinkDistance(left, right, policy) {
  let maximum = 0;
  for (const leftRow of left) {
    for (const rightRow of right) {
      maximum = Math.max(
        maximum,
        morphologyDistance(
          leftRow.inference.glyphMorphology,
          rightRow.inference.glyphMorphology,
          policy,
        ),
      );
    }
  }
  return maximum;
}

/** Deterministic complete-link clustering prevents a chain of weak matches from flattening real variants. */
function clusterMorphologyRows(rows, policy = POLICY) {
  const clusters = [...rows]
    .sort((left, right) => compareStrings(left.blockId, right.blockId))
    .map((row) => [row]);
  while (true) {
    let selected = null;
    for (let left = 0; left < clusters.length; left += 1) {
      for (let right = left + 1; right < clusters.length; right += 1) {
        const distance = completeLinkDistance(
          clusters[left],
          clusters[right],
          policy,
        );
        if (distance > policy.maximumCompleteLinkMorphologyDistance) continue;
        const key = `${clusters[left][0].blockId}:${clusters[right][0].blockId}`;
        if (
          !selected ||
          distance < selected.distance ||
          (distance === selected.distance && key < selected.key)
        ) {
          selected = { left, right, distance, key };
        }
      }
    }
    if (!selected) break;
    const merged = [
      ...clusters[selected.left],
      ...clusters[selected.right],
    ].sort((left, right) => compareStrings(left.blockId, right.blockId));
    clusters.splice(selected.right, 1);
    clusters.splice(selected.left, 1, merged);
  }
  return clusters.sort(
    (left, right) =>
      right.length - left.length ||
      compareStrings(left[0]?.blockId ?? "", right[0]?.blockId ?? ""),
  );
}

function normalizedBbox(item) {
  const bbox = asRecord(item?.bbox);
  const values = [bbox.x, bbox.y, bbox.w, bbox.h].map(Number);
  if (!values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0) {
    return null;
  }
  return { x: values[0], y: values[1], w: values[2], h: values[3] };
}

function isFragmentGeometry(row, policy = POLICY) {
  const bbox = normalizedBbox(row.item);
  if (!bbox) return true;
  const candidateCount = Array.isArray(row.item?.candidateIds)
    ? row.item.candidateIds.length
    : 0;
  if (candidateCount > 1) return false;
  const morphology = row.inference.glyphMorphology;
  const longEdge = Math.max(bbox.w, bbox.h);
  const shortEdge = Math.min(bbox.w, bbox.h);
  return (
    longEdge <= policy.fragmentMaximumLongEdge ||
    (shortEdge <= policy.fragmentMaximumShortEdge &&
      morphology.connectedComponentCount <=
        policy.fragmentMaximumComponentCount)
  );
}

function candidatePixelScore(candidate) {
  return Math.max(
    0,
    finiteNumber(candidate?.rawPixelScore, finiteNumber(candidate?.totalScore)),
  );
}

function rawRank(candidate) {
  return finiteNumber(
    candidate?.rawPixelRank,
    finiteNumber(candidate?.rank, 99),
  );
}

function isStableBodyFont(fontId) {
  return STABLE_BALLOON_BODY_FONT_IDS.has(fontId);
}

function stableBodyFamily(fontId) {
  if (STABLE_BALLOON_SANS_FONT_IDS.has(fontId)) return "sans";
  if (STABLE_BALLOON_SERIF_FONT_IDS.has(fontId)) return "serif";
  return null;
}

function eligibleCandidate(row, fontId) {
  return row.inference.localEvidence.rankedCandidates.find(
    (candidate) =>
      candidate.fontId === fontId &&
      candidate.renderStatus === "rendered" &&
      rawRank(candidate) <= POLICY.transferMaximumRawRank,
  );
}

function bestStableBodyCandidate(row) {
  return (
    [...row.inference.localEvidence.rankedCandidates]
      .filter(
        (candidate) =>
          candidate.renderStatus === "rendered" &&
          isStableBodyFont(candidate.fontId) &&
          rawRank(candidate) <= POLICY.transferMaximumRawRank,
      )
      .sort(
        (left, right) =>
          rawRank(left) - rawRank(right) ||
          candidatePixelScore(right) - candidatePixelScore(left) ||
          compareStrings(left.fontId, right.fontId),
      )[0] ?? null
  );
}

function hasStrongLocalVariantEvidence(row) {
  if (
    isStableBodyFont(row.decision?.selectedFontId) &&
    ["stable_body", "page_anchor"].includes(row.pageState?.mode)
  ) {
    return false;
  }
  const ranked = [...row.inference.localEvidence.rankedCandidates]
    .filter((candidate) => candidate.renderStatus === "rendered")
    .sort(
      (left, right) =>
        rawRank(left) - rawRank(right) ||
        candidatePixelScore(right) - candidatePixelScore(left) ||
        compareStrings(left.fontId, right.fontId),
    );
  const winner = ranked[0];
  if (!winner || isStableBodyFont(winner.fontId)) return false;
  const body = ranked.find((candidate) => isStableBodyFont(candidate.fontId));
  return (
    candidatePixelScore(winner) >= POLICY.minimumStrongVariantWinnerScore &&
    candidatePixelScore(winner) - candidatePixelScore(body) >=
      POLICY.minimumStrongVariantBodyGap
  );
}

function resolveClusterBodyAnchor(cluster) {
  const votes = new Map();
  for (const row of cluster) {
    const stateAnchor = row.pageState?.anchorFontId;
    const currentFont = row.decision?.applied
      ? row.decision.selectedFontId
      : null;
    const sources = [
      [stateAnchor, 2],
      [
        roleProbability(row.inference, DIALOGUE_ROLE) >=
        POLICY.minimumStrongDialogueProbability
          ? currentFont
          : null,
        2,
      ],
    ];
    for (const [fontId, weight] of sources) {
      if (!isStableBodyFont(fontId) || !eligibleCandidate(row, fontId))
        continue;
      const vote = votes.get(fontId) ?? { fontId, support: 0, value: 0 };
      vote.support += 1;
      vote.value += weight;
      votes.set(fontId, vote);
    }
    for (const candidate of row.inference.localEvidence.rankedCandidates) {
      if (
        !isStableBodyFont(candidate.fontId) ||
        candidate.renderStatus !== "rendered" ||
        rawRank(candidate) > POLICY.transferMaximumRawRank
      ) {
        continue;
      }
      const vote = votes.get(candidate.fontId) ?? {
        fontId: candidate.fontId,
        support: 0,
        value: 0,
      };
      vote.support += 1;
      vote.value +=
        0.5 / Math.max(1, rawRank(candidate)) +
        0.5 * candidatePixelScore(candidate);
      votes.set(candidate.fontId, vote);
    }
  }
  const ranked = [...votes.values()].sort(
    (left, right) =>
      right.support - left.support ||
      right.value - left.value ||
      compareStrings(left.fontId, right.fontId),
  );
  const winner = ranked[0];
  if (!winner || winner.support < Math.min(2, cluster.length)) return null;
  return {
    fontId: winner.fontId,
    family: stableBodyFamily(winner.fontId),
    support: winner.support,
    value: winner.value,
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function isSubstantiveRow(row) {
  return (
    !isFragmentGeometry(row) &&
    row.inference.treatment?.distortion === "none" &&
    isValidMorphology(row.inference.glyphMorphology)
  );
}

function chooseDominantCluster(directionRows, clusters) {
  const winner = clusters[0];
  const runner = clusters[1];
  if (!winner || winner.length === runner?.length) return null;
  const share = winner.length / directionRows.length;
  if (share < POLICY.minimumDominantClusterShare) return null;
  const seeds = winner.filter(
    (row) =>
      roleProbability(row.inference, DIALOGUE_ROLE) >=
        POLICY.minimumStrongDialogueProbability && isSubstantiveRow(row),
  );
  const substantiveRows = winner.filter(isSubstantiveRow);
  const medianMorphology = {
    globalDistance: median(
      substantiveRows.map(
        (row) => row.inference.glyphMorphology.globalForegroundDistanceMean,
      ),
    ),
    componentDistance: median(
      substantiveRows.map(
        (row) => row.inference.glyphMorphology.medianComponentDistanceMean,
      ),
    ),
    foregroundLuma: median(
      substantiveRows.map(
        (row) => row.inference.glyphMorphology.foregroundMeanLuma,
      ),
    ),
  };
  const selfAnchored =
    (directionRows[0]?.item?.direction ??
      directionRows[0]?.inference.treatment?.orientation) === "vertical" &&
    winner.length >= POLICY.minimumSelfAnchoredClusterSize &&
    substantiveRows.length >= POLICY.minimumSelfAnchoredSubstantiveRows &&
    median(
      substantiveRows.map((row) =>
        roleProbability(row.inference, DIALOGUE_ROLE),
      ),
    ) >= POLICY.minimumSelfAnchorMedianDialogueProbability &&
    medianMorphology.globalDistance <=
      POLICY.maximumSelfAnchorMedianGlobalDistance &&
    medianMorphology.componentDistance <=
      POLICY.maximumSelfAnchorMedianComponentDistance &&
    medianMorphology.foregroundLuma >=
      POLICY.minimumSelfAnchorMedianForegroundLuma;
  if (seeds.length < POLICY.minimumSeedCount && !selfAnchored) return null;
  return {
    rows: winner,
    share,
    seedCount: seeds.length,
    selfAnchored,
    substantiveCount: substantiveRows.length,
    medianMorphology,
  };
}

function buildRows(inferences, items, decisions, pageStates) {
  const itemByBlockId = new Map(
    items.filter(Boolean).map((item) => [item.blockId, item.item ?? item]),
  );
  const decisionByBlockId = new Map(
    decisions.filter(Boolean).map((decision) => [decision.blockId, decision]),
  );
  return inferences.filter(Boolean).map((inference) => ({
    blockId: inference.blockId,
    inference,
    item: itemByBlockId.get(inference.blockId),
    decision: decisionByBlockId.get(inference.blockId),
    pageState: pageStates.get(inference.blockId),
  }));
}

function nearestSplitPeer(row, rows) {
  const left = normalizedBbox(row.item);
  if (!left) return null;
  const leftMorphology = row.inference.glyphMorphology;
  let winner = null;
  for (const candidateRow of rows) {
    if (candidateRow.blockId === row.blockId) continue;
    if (candidateRow.projectedRole !== EMPHASIS_ROLE) continue;
    if (candidateRow.item?.direction !== row.item?.direction) continue;
    if (!isFragmentGeometry(candidateRow)) continue;
    if (
      roleProbability(candidateRow.inference, EMPHASIS_ROLE) < 0.9 ||
      !candidateRow.decision?.applied ||
      candidateRow.decision.selectedFontId === SINGLE_DAY_FONT_ID
    ) {
      continue;
    }
    const target = eligibleCandidate(row, candidateRow.decision.selectedFontId);
    if (!target || target.fontId === SINGLE_DAY_FONT_ID) continue;
    const right = normalizedBbox(candidateRow.item);
    if (!right) continue;
    const xGap = axisGap(left.x, left.x + left.w, right.x, right.x + right.w);
    const yGap = axisGap(left.y, left.y + left.h, right.y, right.y + right.h);
    const edgeGap = Math.hypot(xGap, yGap);
    const centerDistance = Math.hypot(
      left.x + left.w / 2 - (right.x + right.w / 2),
      left.y + left.h / 2 - (right.y + right.h / 2),
    );
    const maximumEdge = Math.max(left.w, left.h, right.w, right.h);
    const morphology = morphologyDistance(
      leftMorphology,
      candidateRow.inference.glyphMorphology,
    );
    if (
      edgeGap > POLICY.splitPeerMaximumEdgeGap ||
      centerDistance / maximumEdge >
        POLICY.splitPeerMaximumCenterDistanceRatio ||
      morphology > 1.15
    ) {
      continue;
    }
    const value = edgeGap + centerDistance / maximumEdge + morphology;
    if (!winner || value < winner.value) {
      winner = { row: candidateRow, candidate: target, value };
    }
  }
  return winner;
}

function axisGap(leftStart, leftEnd, rightStart, rightEnd) {
  return Math.max(
    0,
    Math.max(leftStart, rightStart) - Math.min(leftEnd, rightEnd),
  );
}

/**
 * Pixel/geometry-only projection. It deliberately preserves `applied` and all
 * style fields. A live candidate must recompute body-head scores; this replay
 * only says whether the route is promising enough to justify that expense.
 */
function buildPageRelativeProjection(inferences, items, decisions, pageStates) {
  const rows = buildRows(inferences, items, decisions, pageStates).map(
    (row) => ({
      ...row,
      projectedRole: row.inference.rolePrediction.primary,
      projectedRoute: row.inference.scoreRoute?.family ?? null,
      projectedFontId: row.decision?.selectedFontId ?? null,
      reasonCodes: [],
      cluster: null,
    }),
  );
  const groups = new Map();
  for (const row of rows) {
    if (
      !isValidMorphology(row.inference.glyphMorphology) ||
      row.inference.treatment?.distortion !== "none"
    ) {
      continue;
    }
    const direction =
      row.item?.direction ?? row.inference.treatment?.orientation;
    const group = groups.get(direction) ?? [];
    group.push(row);
    groups.set(direction, group);
  }
  const clusterReports = [];
  for (const [direction, directionRows] of groups) {
    const clusters = clusterMorphologyRows(directionRows);
    const dominant = chooseDominantCluster(directionRows, clusters);
    if (!dominant) continue;
    const anchor = resolveClusterBodyAnchor(dominant.rows);
    if (!anchor) continue;
    const clusterId = `${direction}:dominant-${clusterReports.length + 1}`;
    clusterReports.push({
      clusterId,
      direction,
      size: dominant.rows.length,
      directionRowCount: directionRows.length,
      share: dominant.share,
      seedCount: dominant.seedCount,
      selfAnchored: dominant.selfAnchored,
      substantiveCount: dominant.substantiveCount,
      anchor,
      blockIds: dominant.rows.map((row) => row.blockId),
    });
    for (const row of dominant.rows) {
      row.cluster = clusterId;
      if (row.projectedRole !== EMPHASIS_ROLE) continue;
      if (!isSubstantiveRow(row)) {
        row.reasonCodes.push("preserve_structural_fragment_variant");
        continue;
      }
      if (
        roleProbability(row.inference, DIALOGUE_ROLE) <
        POLICY.minimumRecoveryDialogueProbability
      ) {
        row.reasonCodes.push("preserve_near_zero_dialogue_probability");
        continue;
      }
      if (hasStrongLocalVariantEvidence(row)) {
        row.reasonCodes.push("preserve_strong_local_variant_pixel_gap");
        continue;
      }
      const bodyTarget =
        eligibleCandidate(row, anchor.fontId) ?? bestStableBodyCandidate(row);
      if (!bodyTarget) {
        row.reasonCodes.push("preserve_no_top3_body_transfer_target");
        continue;
      }
      row.projectedRole = DIALOGUE_ROLE;
      row.projectedRoute = "body";
      if (
        row.decision?.applied &&
        !isStableBodyFont(row.decision.selectedFontId)
      ) {
        row.projectedFontId = bodyTarget.fontId;
      }
      row.reasonCodes.push(
        dominant.selfAnchored
          ? "page_relative_dominant_ordinary_morphology"
          : "page_relative_seeded_ordinary_morphology",
        isStableBodyFont(row.decision?.selectedFontId)
          ? "preserve_existing_stable_body_rank"
          : bodyTarget.fontId === anchor.fontId
            ? "page_relative_body_anchor_rank"
            : "row_local_top3_body_rank",
      );
    }
  }

  for (const row of rows) {
    const selectedFontId = row.decision?.selectedFontId;
    if (
      !row.decision?.applied ||
      row.projectedRole !== EMPHASIS_ROLE ||
      selectedFontId !== SINGLE_DAY_FONT_ID ||
      !isFragmentGeometry(row) ||
      roleProbability(row.inference, EMPHASIS_ROLE) < 0.9
    ) {
      continue;
    }
    const peer = nearestSplitPeer(row, rows);
    if (!peer) {
      row.reasonCodes.push("preserve_isolated_single_day_variant");
      continue;
    }
    row.projectedFontId = peer.candidate.fontId;
    row.reasonCodes.push(
      "split_fragment_peer_rank",
      `peer:${peer.row.blockId}`,
    );
  }

  return { rows, clusterReports };
}

function countValues(values) {
  const counts = {};
  for (const value of values) {
    const key = String(value ?? "unknown");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function bodyConsistencySummary(pages, projected) {
  let eligiblePages = 0;
  let appliedBlocks = 0;
  let dominantBlocks = 0;
  let multiFontPages = 0;
  for (const page of pages) {
    const decisions = projected
      ? page.projectedDecisions
      : page.currentDecisions;
    const body = decisions.filter(
      (decision) =>
        decision.applied &&
        ["dialogue", "narration", "thought"].includes(decision.role) &&
        decision.selectedFontId,
    );
    if (body.length < 2) continue;
    const counts = countValues(body.map((decision) => decision.selectedFontId));
    eligiblePages += 1;
    appliedBlocks += body.length;
    dominantBlocks += Math.max(...Object.values(counts));
    if (Object.keys(counts).length > 1) multiFontPages += 1;
  }
  return {
    eligiblePages,
    appliedBlocks,
    dominantBlocks,
    dominantShare: appliedBlocks ? dominantBlocks / appliedBlocks : 0,
    multiFontPages,
  };
}

function summarizePages(pages, projected) {
  const decisions = pages.flatMap((page) =>
    projected ? page.projectedDecisions : page.currentDecisions,
  );
  const applied = decisions.filter((decision) => decision.applied);
  return {
    pages: pages.length,
    blocks: decisions.length,
    appliedBlocks: applied.length,
    automaticApplyRate: decisions.length
      ? applied.length / decisions.length
      : 0,
    emphasisBlocks: decisions.filter(
      (decision) => decision.role === EMPHASIS_ROLE,
    ).length,
    emphasisRate: decisions.length
      ? decisions.filter((decision) => decision.role === EMPHASIS_ROLE).length /
        decisions.length
      : 0,
    appliedSingleDayBlocks: applied.filter(
      (decision) => decision.selectedFontId === SINGLE_DAY_FONT_ID,
    ).length,
    appliedBodySingleDayBlocks: applied.filter(
      (decision) =>
        decision.selectedFontId === SINGLE_DAY_FONT_ID &&
        ["dialogue", "narration", "thought"].includes(decision.role),
    ).length,
    selectedFontCounts: countValues(
      applied.map((decision) => decision.selectedFontId),
    ),
    roleCounts: countValues(decisions.map((decision) => decision.role)),
    bodyConsistency: bodyConsistencySummary(pages, projected),
  };
}

function projectedDecision(decision, row) {
  if (!row || !decision.applied) return { ...decision };
  return {
    ...decision,
    role: row.projectedRole,
    selectedFontId: row.projectedFontId,
  };
}

async function evaluateRun(runDir) {
  const reportPath = path.join(runDir, "run-report.json");
  const report = JSON.parse(await fsp.readFile(reportPath, "utf8"));
  const pages = [];
  const inferenceFiles = [];
  for (const pageReport of report.pages ?? []) {
    if (pageReport.status !== "completed") continue;
    const pageNumber = finiteNumber(pageReport.selectionIndex) + 1;
    const inferencePath = path.join(
      runDir,
      "pages",
      String(pageNumber).padStart(2, "0"),
      "font-inference.json",
    );
    const bytes = await fsp.readFile(inferencePath);
    const inference = JSON.parse(bytes.toString("utf8"));
    const inferences = Array.isArray(inference.pixelInference)
      ? inference.pixelInference
      : [];
    const items = Array.isArray(inference.requestBlocks)
      ? inference.requestBlocks
      : [];
    const itemByBlockId = new Map(
      items.map((entry) => [entry.blockId, entry.item]),
    );
    const alignedItems = inferences.map((entry) =>
      itemByBlockId.get(entry.blockId),
    );
    const pageStates = buildAutomaticFontPageConsistencyPlan(
      inferences,
      alignedItems,
    );
    const projection = buildPageRelativeProjection(
      inferences,
      items,
      pageReport.fontDecisions ?? [],
      pageStates,
    );
    const projectedByBlockId = new Map(
      projection.rows.map((row) => [row.blockId, row]),
    );
    const currentDecisions = pageReport.fontDecisions ?? [];
    const projectedDecisions = currentDecisions.map((decision) =>
      projectedDecision(decision, projectedByBlockId.get(decision.blockId)),
    );
    const changes = projection.rows
      .filter(
        (row) =>
          row.projectedRole !== row.inference.rolePrediction.primary ||
          (row.decision?.applied &&
            row.projectedFontId !== row.decision.selectedFontId),
      )
      .map((row) => ({
        blockId: row.blockId,
        blockIndex: row.decision?.blockIndex ?? null,
        sourceText: row.decision?.sourceText ?? null,
        bbox: row.item?.bbox ?? null,
        candidateIds: row.item?.candidateIds ?? [],
        direction: row.item?.direction ?? null,
        currentRole: row.inference.rolePrediction.primary,
        projectedRole: row.projectedRole,
        dialogueProbability: roleProbability(row.inference, DIALOGUE_ROLE),
        emphasisProbability: roleProbability(row.inference, EMPHASIS_ROLE),
        currentRoute: row.inference.scoreRoute?.family ?? null,
        projectedRoute: row.projectedRoute,
        currentFontId: row.decision?.selectedFontId ?? null,
        projectedFontId: row.projectedFontId,
        appliedUnchanged: Boolean(row.decision?.applied),
        glyphMorphology: row.inference.glyphMorphology,
        existingPageConsistencyState: row.pageState ?? null,
        cluster: row.cluster,
        reasonCodes: row.reasonCodes,
      }));
    const preservedVariants = projection.rows
      .filter(
        (row) =>
          row.projectedRole === EMPHASIS_ROLE &&
          row.reasonCodes.some((reason) => reason.startsWith("preserve_")),
      )
      .map((row) => ({
        blockId: row.blockId,
        blockIndex: row.decision?.blockIndex ?? null,
        sourceText: row.decision?.sourceText ?? null,
        bbox: row.item?.bbox ?? null,
        direction: row.item?.direction ?? null,
        dialogueProbability: roleProbability(row.inference, DIALOGUE_ROLE),
        emphasisProbability: roleProbability(row.inference, EMPHASIS_ROLE),
        currentFontId: row.decision?.selectedFontId ?? null,
        projectedFontId: row.projectedFontId,
        glyphMorphology: row.inference.glyphMorphology,
        cluster: row.cluster,
        reasonCodes: row.reasonCodes.filter((reason) =>
          reason.startsWith("preserve_"),
        ),
      }));
    pages.push({
      pageNumber,
      sourcePageId: pageReport.sourcePageId,
      workId: pageReport.workId,
      chapterId: pageReport.chapterId,
      currentDecisions,
      projectedDecisions,
      inferenceBlockCount: inferences.length,
      clusters: projection.clusterReports,
      changes,
      preservedVariants,
      knownVisualAnchor: KNOWN_BAD_PAGES.has(pageNumber)
        ? "known_bad"
        : KNOWN_IMPROVED_PAGES.has(pageNumber)
          ? "known_improved"
          : null,
    });
    inferenceFiles.push({
      pageNumber,
      relativePath: path.relative(runDir, inferencePath).replaceAll("\\", "/"),
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  }
  const current = summarizePages(pages, false);
  const projected = summarizePages(pages, true);
  const roleChanges = pages
    .flatMap((page) => page.changes)
    .filter((change) => change.currentRole !== change.projectedRole).length;
  const fontChanges = pages
    .flatMap((page) => page.changes)
    .filter((change) => change.currentFontId !== change.projectedFontId).length;
  return {
    runId: report.runId,
    candidateId: report.candidateId,
    cohort: report.cohort,
    cohortDigest: report.cohortDigest,
    input: {
      runDir,
      runReportSha256: sha256(await fsp.readFile(reportPath)),
      inferenceFiles,
      combinedInferenceSha256: sha256(
        Buffer.from(
          inferenceFiles
            .map((entry) => `${entry.relativePath}\0${entry.sha256}`)
            .join("\n"),
        ),
      ),
    },
    current,
    projected,
    deltas: {
      automaticApplyRate:
        projected.automaticApplyRate - current.automaticApplyRate,
      emphasisRate: projected.emphasisRate - current.emphasisRate,
      bodyDominantShare:
        projected.bodyConsistency.dominantShare -
        current.bodyConsistency.dominantShare,
      bodyEligiblePages:
        projected.bodyConsistency.eligiblePages -
        current.bodyConsistency.eligiblePages,
      multiFontBodyPages:
        projected.bodyConsistency.multiFontPages -
        current.bodyConsistency.multiFontPages,
      appliedSingleDayBlocks:
        projected.appliedSingleDayBlocks - current.appliedSingleDayBlocks,
      appliedBodySingleDayBlocks:
        projected.appliedBodySingleDayBlocks -
        current.appliedBodySingleDayBlocks,
    },
    roleChanges,
    fontChanges,
    pages: pages.map((page) => ({
      pageNumber: page.pageNumber,
      sourcePageId: page.sourcePageId,
      workId: page.workId,
      chapterId: page.chapterId,
      inferenceBlockCount: page.inferenceBlockCount,
      knownVisualAnchor: page.knownVisualAnchor,
      clusters: page.clusters,
      roleChanges: page.changes.filter(
        (change) => change.currentRole !== change.projectedRole,
      ).length,
      fontChanges: page.changes.filter(
        (change) => change.currentFontId !== change.projectedFontId,
      ).length,
      preservedVariantCount: page.preservedVariants.length,
      preservationReasonCounts: countValues(
        page.preservedVariants.flatMap((row) => row.reasonCodes),
      ),
      preservedVariants: page.preservedVariants,
      changes: page.changes,
    })),
  };
}

async function diagnosticValidationBoundary(validationDir, val33Path) {
  const routingPath = path.join(validationDir, "routing-audit-rows.jsonl");
  const visualPath = path.join(validationDir, "evaluation-rows.jsonl");
  const files = [];
  for (const [name, filePath] of [
    ["all9033", routingPath],
    ["visual1047", visualPath],
    ["val33", val33Path],
  ]) {
    const bytes = await fsp.readFile(filePath);
    const rows = bytes.toString("utf8").split(/\r?\n/u).filter(Boolean);
    files.push({
      name,
      path: filePath,
      rows: rows.length,
      sha256: sha256(bytes),
    });
  }
  return {
    status: "unavailable_fail_closed",
    reason:
      "The sealed all9033/visual1047 evaluation rows expose work_id and family probabilities but no page-local glyph morphology. Val33 has page_id/geometry but no matching sealed runtime morphology. Applying a page-relative rule would therefore fabricate unavailable evidence.",
    evaluatedRows: 0,
    selectionUsed: false,
    files,
  };
}

function safetyReport(run) {
  const failures = [];
  if (run.deltas.automaticApplyRate < 0)
    failures.push("automatic_apply_rate_dropped");
  if (run.deltas.appliedBodySingleDayBlocks > 0) {
    failures.push("body_role_single_day_increased");
  }
  const changedApplied = run.pages
    .flatMap((page) => page.changes)
    .filter((change) => change.appliedUnchanged);
  return {
    passed: failures.length === 0,
    failures,
    predeclared: {
      singleDayEligibility: "unchanged",
      outlineAndStyle: "unchanged",
      automaticApply: "preserved_exactly",
      mutationScope: "role_family_route_and_rank_projection_only",
      gemmaTextGenreInputs: "absent",
    },
    evidence: {
      automaticApplyRateDelta: run.deltas.automaticApplyRate,
      appliedBodySingleDayDelta: run.deltas.appliedBodySingleDayBlocks,
      appliedChangedBlocks: changedApplied.length,
    },
  };
}

function anchorSummary(run) {
  return run.pages
    .filter((page) => page.knownVisualAnchor)
    .map((page) => ({
      pageNumber: page.pageNumber,
      expectation: page.knownVisualAnchor,
      roleChanges: page.roleChanges,
      fontChanges: page.fontChanges,
      reasons: countValues(
        page.changes.flatMap((change) => change.reasonCodes),
      ),
      preservedVariantCount: page.preservedVariantCount,
      preservationReasons: page.preservationReasonCounts,
    }));
}

function liveCandidateVerdict(r3, r4, validation) {
  const safety = safetyReport(r3);
  const changedShare = r3.current.emphasisBlocks
    ? r3.roleChanges / r3.current.emphasisBlocks
    : 0;
  const badAnchorChanges = anchorSummary(r3)
    .filter((entry) => entry.expectation === "known_bad")
    .reduce((sum, entry) => sum + entry.roleChanges + entry.fontChanges, 0);
  const reasons = [];
  if (!safety.passed) reasons.push("safety_preconditions_failed");
  if (changedShare > 0.55) reasons.push("role_projection_is_too_aggressive");
  if (r3.deltas.bodyDominantShare <= 0) {
    reasons.push("same_page_body_consistency_did_not_improve");
  }
  if (badAnchorChanges < 3) reasons.push("known_bad_anchor_coverage_too_low");
  if (validation.status !== "completed") {
    reasons.push("sealed_validation_lacks_page_morphology_for_offline_check");
  }
  const useful =
    safety.passed &&
    changedShare <= 0.55 &&
    r3.deltas.bodyDominantShare > 0 &&
    badAnchorChanges >= 3;
  return {
    verdict: useful
      ? "conditional_live_40_candidate_after_changed_block_visual_review"
      : "do_not_run_live_40_yet",
    usefulSignal: useful,
    reasons,
    evidence: {
      r3ChangedEmphasisShare: changedShare,
      r3BodyDominantShareDelta: r3.deltas.bodyDominantShare,
      r4BodyDominantShareDelta: r4.deltas.bodyDominantShare,
      knownBadAnchorChanges: badAnchorChanges,
      validationStatus: validation.status,
    },
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function formatPercent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function buildMarkdown(report) {
  const lines = [
    "# Page-relative role ablation (evaluator only)",
    "",
    `- Policy: ${report.policy.name}`,
    `- Live-candidate verdict: ${report.liveCandidate.verdict}`,
    `- R3 emphasis rate: ${formatPercent(report.r3.current.emphasisRate)} → ${formatPercent(report.r3.projected.emphasisRate)}`,
    `- R3 same-page body dominant share: ${formatPercent(report.r3.current.bodyConsistency.dominantShare)} → ${formatPercent(report.r3.projected.bodyConsistency.dominantShare)}`,
    `- R3 role/font changes: ${report.r3.roleChanges}/${report.r3.fontChanges}`,
    `- R4 emphasis rate: ${formatPercent(report.r4.current.emphasisRate)} → ${formatPercent(report.r4.projected.emphasisRate)}`,
    `- R4 same-page body dominant share: ${formatPercent(report.r4.current.bodyConsistency.dominantShare)} → ${formatPercent(report.r4.projected.bodyConsistency.dominantShare)}`,
    `- R4 role/font changes: ${report.r4.roleChanges}/${report.r4.fontChanges}`,
    `- Automatic apply delta (R3/R4): ${formatPercent(report.r3.deltas.automaticApplyRate)} / ${formatPercent(report.r4.deltas.automaticApplyRate)}`,
    `- Applied Single Day body-role delta (R3/R4): ${report.r3.deltas.appliedBodySingleDayBlocks} / ${report.r4.deltas.appliedBodySingleDayBlocks}`,
    `- Validation diagnostic: ${report.validation.status}`,
    "",
    "This report never mutates production. Text, Gemma roles, translations, and genre are absent from the policy input. A live body-head rerun and visual review remain mandatory.",
    "",
    "## Known visual anchors",
    "",
    "| Run | Page | Prior observation | Role changes | Font changes | Preserved variants |",
    "| --- | ---: | --- | ---: | ---: | ---: |",
  ];
  for (const [name, run] of [
    ["r3", report.r3],
    ["r4", report.r4],
  ]) {
    for (const anchor of run.knownVisualAnchors) {
      lines.push(
        `| ${name} | ${anchor.pageNumber} | ${anchor.expectation} | ${anchor.roleChanges} | ${anchor.fontChanges} | ${anchor.preservedVariantCount} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

function parseArgs(argv) {
  const values = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || !key?.startsWith("--"))
      throw new Error(`Invalid argument: ${key}`);
    index += 1;
    if (key === "--r3") values.r3 = path.resolve(value);
    else if (key === "--r4") values.r4 = path.resolve(value);
    else if (key === "--validation") values.validation = path.resolve(value);
    else if (key === "--val33") values.val33 = path.resolve(value);
    else if (key === "--output") values.output = path.resolve(value);
    else throw new Error(`Unknown argument: ${key}`);
  }
  return values;
}

async function runAblation(options = DEFAULTS) {
  const [r3, r4, validation] = await Promise.all([
    evaluateRun(options.r3),
    evaluateRun(options.r4),
    diagnosticValidationBoundary(options.validation, options.val33),
  ]);
  if (r3.cohortDigest !== r4.cohortDigest) {
    throw new Error("R3 and R4 inputs do not share the frozen cohort digest.");
  }
  r3.safety = safetyReport(r3);
  r4.safety = safetyReport(r4);
  r3.knownVisualAnchors = anchorSummary(r3);
  r4.knownVisualAnchors = anchorSummary(r4);
  const report = {
    schemaVersion: "manga-font-page-relative-role-ablation-v1",
    generatedAt: new Date().toISOString(),
    authority: "evaluation_only_non_promotable",
    policy: POLICY,
    frozenCohortDigest: r3.cohortDigest,
    r3,
    r4,
    validation,
    liveCandidate: liveCandidateVerdict(r3, r4, validation),
  };
  await fsp.mkdir(options.output, { recursive: true });
  await Promise.all([
    fsp.writeFile(
      path.join(options.output, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    ),
    fsp.writeFile(
      path.join(options.output, "report.md"),
      buildMarkdown(report),
      "utf8",
    ),
  ]);
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runAblation(options);
  process.stdout.write(
    `${JSON.stringify(
      {
        output: options.output,
        verdict: report.liveCandidate.verdict,
        r3: {
          roleChanges: report.r3.roleChanges,
          fontChanges: report.r3.fontChanges,
          emphasisBefore: report.r3.current.emphasisRate,
          emphasisAfter: report.r3.projected.emphasisRate,
          dominantBefore: report.r3.current.bodyConsistency.dominantShare,
          dominantAfter: report.r3.projected.bodyConsistency.dominantShare,
        },
        r4: {
          roleChanges: report.r4.roleChanges,
          fontChanges: report.r4.fontChanges,
          emphasisBefore: report.r4.current.emphasisRate,
          emphasisAfter: report.r4.projected.emphasisRate,
          dominantBefore: report.r4.current.bodyConsistency.dominantShare,
          dominantAfter: report.r4.projected.bodyConsistency.dominantShare,
        },
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
  POLICY,
  buildPageRelativeProjection,
  clusterMorphologyRows,
  diagnosticValidationBoundary,
  evaluateRun,
  isFragmentGeometry,
  morphologyDistance,
  roleProbability,
  runAblation,
};
