/* eslint-disable @typescript-eslint/ban-ts-comment -- library candidates are schema-flexible QA records */
// @ts-nocheck -- candidate shapes are validated by the library reader.
const nodeCrypto = require("node:crypto");

/**
 * Select both cohorts together so the first cohort cannot consume every scarce
 * work/chapter before the holdout is allocated. Each phase gives the next pick
 * to the less-complete cohort and favors work coverage before concentration.
 * @param {any[]} candidates
 * @param {{ seed: string; baselineCount: number; holdoutCount: number }} options
 */
function selectQaCohorts(candidates, options) {
  const states = [
    createCohortState("baseline", options.baselineCount),
    createCohortState("holdout", options.holdoutCount),
  ];
  const allocation = {
    seed: options.seed,
    turn: 0,
    usedPageIds: new Set(),
    usedChapterIds: new Set(),
  };

  // Reserve half of each cohort for known expressive/effect pages. Allocating
  // the two reserves jointly prevents baseline from taking all variant chapters.
  selectJointPhase(candidates, states, allocation, true);
  selectJointPhase(candidates, states, allocation, false);

  const [baseline, holdout] = states.map((state) => state.selected);
  if (
    baseline.length !== options.baselineCount ||
    holdout.length !== options.holdoutCount
  ) {
    throw new Error(
      `Not enough non-training library pages for ${options.baselineCount}+${options.holdoutCount} QA pages ` +
        `(selected ${baseline.length}+${holdout.length}).`,
    );
  }
  return { baseline, holdout };
}

/** @param {"baseline" | "holdout"} name @param {number} target */
function createCohortState(name, target) {
  return { name, target, selected: [], workCounts: new Map() };
}

/**
 * @param {any[]} candidates
 * @param {ReturnType<typeof createCohortState>[]} states
 * @param {{ seed: string; turn: number; usedPageIds: Set<string>; usedChapterIds: Set<string> }} allocation
 * @param {boolean} variantOnly
 */
function selectJointPhase(candidates, states, allocation, variantOnly) {
  const blocked = new Set();
  while (true) {
    const pending = states.filter(
      (state) =>
        state.selected.length < phaseTarget(state, variantOnly) &&
        !blocked.has(state.name),
    );
    if (pending.length === 0) return;
    pending.sort((left, right) =>
      compareCohortTurns(left, right, allocation, variantOnly),
    );
    const state = pending[0];
    const picked = pickJointCandidate(
      candidates,
      state,
      states,
      allocation,
      variantOnly,
    );
    if (!picked) {
      blocked.add(state.name);
      continue;
    }
    state.selected.push(picked);
    state.workCounts.set(
      picked.workId,
      (state.workCounts.get(picked.workId) || 0) + 1,
    );
    allocation.usedPageIds.add(picked.pageId);
    allocation.usedChapterIds.add(picked.chapterId);
    allocation.turn += 1;
  }
}

/** @param {ReturnType<typeof createCohortState>} state @param {boolean} variantOnly */
function phaseTarget(state, variantOnly) {
  return variantOnly ? Math.floor(state.target / 2) : state.target;
}

/**
 * @param {ReturnType<typeof createCohortState>} left
 * @param {ReturnType<typeof createCohortState>} right
 * @param {{ seed: string; turn: number }} allocation
 * @param {boolean} variantOnly
 */
function compareCohortTurns(left, right, allocation, variantOnly) {
  const leftTarget = phaseTarget(left, variantOnly);
  const rightTarget = phaseTarget(right, variantOnly);
  const progress =
    left.selected.length * rightTarget - right.selected.length * leftTarget;
  if (progress !== 0) return progress;
  if (left.workCounts.size !== right.workCounts.size) {
    return left.workCounts.size - right.workCounts.size;
  }
  const concentration = maximumWorkCount(left) - maximumWorkCount(right);
  if (concentration !== 0) return concentration;
  const phase = variantOnly ? "variant" : "general";
  return seededHash(
    allocation.seed,
    `cohort-turn:${phase}:${allocation.turn}:${left.name}`,
  ).localeCompare(
    seededHash(
      allocation.seed,
      `cohort-turn:${phase}:${allocation.turn}:${right.name}`,
    ),
  );
}

/** @param {ReturnType<typeof createCohortState>} state */
function maximumWorkCount(state) {
  return Math.max(0, ...state.workCounts.values());
}

/**
 * @param {any[]} candidates
 * @param {ReturnType<typeof createCohortState>} state
 * @param {ReturnType<typeof createCohortState>[]} states
 * @param {{ seed: string; usedPageIds: Set<string>; usedChapterIds: Set<string> }} allocation
 * @param {boolean} variantOnly
 */
function pickJointCandidate(
  candidates,
  state,
  states,
  allocation,
  variantOnly,
) {
  const available = candidates.filter(
    (candidate) =>
      !allocation.usedPageIds.has(candidate.pageId) &&
      !allocation.usedChapterIds.has(candidate.chapterId),
  );
  const remainingChapters = countRemainingChaptersByWork(available);
  const eligible = available.filter(
    (candidate) => !variantOnly || candidate.variantSignalCount > 0,
  );
  const other = states.find((candidateState) => candidateState !== state);
  eligible.sort((left, right) =>
    compareCandidates(left, right, {
      allocation,
      other,
      remainingChapters,
      state,
      variantOnly,
    }),
  );
  return eligible[0] || null;
}

/** @param {any[]} candidates */
function countRemainingChaptersByWork(candidates) {
  const chapters = new Map();
  for (const candidate of candidates) {
    let workChapters = chapters.get(candidate.workId);
    if (!workChapters) {
      workChapters = new Set();
      chapters.set(candidate.workId, workChapters);
    }
    workChapters.add(candidate.chapterId);
  }
  return new Map(
    [...chapters].map(([workId, workChapters]) => [workId, workChapters.size]),
  );
}

/** @param {any} left @param {any} right @param {any} context */
function compareCandidates(left, right, context) {
  const rankDifference = compareNumericRanks(
    candidateRank(left, context),
    candidateRank(right, context),
  );
  if (rankDifference !== 0) return rankDifference;

  const phase = context.variantOnly ? "variant" : "general";
  return seededHash(
    `${context.allocation.seed}:${context.state.name}:${phase}`,
    candidateKey(left),
  ).localeCompare(
    seededHash(
      `${context.allocation.seed}:${context.state.name}:${phase}`,
      candidateKey(right),
    ),
  );
}

/** @param {any} candidate @param {any} context */
function candidateRank(candidate, context) {
  const count = context.state.workCounts.get(candidate.workId) || 0;
  const otherCount = context.other?.workCounts.get(candidate.workId) || 0;
  const remaining = context.remainingChapters.get(candidate.workId) || 0;
  const crossCoverage = count === 0 && otherCount === 0 ? 1 : 0;
  // Claim scarce works while adding coverage; once covered, concentrate on
  // abundant works so the other cohort keeps access to remaining rare works.
  const availability = count === 0 ? remaining : -remaining;
  const styleRank = context.variantOnly
    ? candidate.variantSignals.strongTotal > 0
      ? 0
      : 1
    : candidate.variantSignalCount > 0
      ? 1
      : 0;
  const signalRank = context.variantOnly ? -candidate.variantSignalCount : 0;
  return [
    count,
    crossCoverage,
    count + otherCount,
    availability,
    styleRank,
    signalRank,
  ];
}

/** @param {number[]} left @param {number[]} right */
function compareNumericRanks(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** @param {{ workId: string; chapterId: string; pageId: string }} item */
function candidateKey(item) {
  return `${item.workId}/${item.chapterId}/${item.pageId}`;
}

/** @param {string} seed @param {string} key */
function seededHash(seed, key) {
  return nodeCrypto
    .createHash("sha256")
    .update(`${seed}\0${key}`)
    .digest("hex");
}

module.exports = { selectQaCohorts };
