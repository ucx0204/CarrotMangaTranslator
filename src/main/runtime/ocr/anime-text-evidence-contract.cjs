// @ts-check

const {
  evidenceVersion: ANIME_TEXT_EVIDENCE_VERSION,
  modelRevision: ANIME_TEXT_MODEL_REVISION,
  minimumContainment: MIN_ANIME_TEXT_CONTAINMENT,
  minimumRegionScore: MIN_ANIME_TEXT_REGION_SCORE,
} = require("./anime-text-evidence-contract.json");
const ANIME_TEXT_EVIDENCE_KEYS = [
  "animeTextRegionId",
  "animeTextRegionScore",
  "animeTextContainment",
  "animeTextRegionBbox",
  "animeTextEvidenceVersion",
  "animeTextModelRevision",
];

/**
 * @typedef {Record<string,unknown>} JsonRecord
 * @typedef {{
 *   animeTextRegionId:string;
 *   animeTextRegionScore:number;
 *   animeTextContainment:number;
 *   animeTextRegionBbox:number[];
 *   animeTextEvidenceVersion:number;
 *   animeTextModelRevision:string;
 * }} AnimeTextEvidence
 */

/**
 * Validate the complete evidence tuple at the runtime boundary. A partial
 * tuple is never treated as a weaker hint because that would create an
 * implicit contract between normalization, crop planning, and prompting.
 *
 * @param {JsonRecord} record
 * @param {string} label
 * @returns {AnimeTextEvidence|null}
 */
function readAnimeTextEvidence(record, label) {
  const presentCount = ANIME_TEXT_EVIDENCE_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(record, key),
  ).length;
  if (presentCount === 0) {
    return null;
  }
  if (presentCount !== ANIME_TEXT_EVIDENCE_KEYS.length) {
    throw new Error(`Incomplete anime-text-yolo evidence for ${label}.`);
  }
  const evidence = {
    animeTextRegionId: String(record.animeTextRegionId ?? "")
      .trim()
      .toUpperCase(),
    animeTextRegionScore: Number(record.animeTextRegionScore),
    animeTextContainment: Number(record.animeTextContainment),
    animeTextRegionBbox: readDetectorBox(record.animeTextRegionBbox),
    animeTextEvidenceVersion: Number(record.animeTextEvidenceVersion),
    animeTextModelRevision: String(record.animeTextModelRevision ?? ""),
  };
  if (!isValidAnimeTextEvidence(evidence)) {
    throw new Error(`Invalid anime-text-yolo evidence for ${label}.`);
  }
  return evidence;
}

/**
 * Optional detector evidence must fail closed rather than interrupt grouping.
 *
 * @param {JsonRecord} record
 * @param {string} label
 * @returns {AnimeTextEvidence|null}
 */
function tryReadAnimeTextEvidence(record, label) {
  try {
    return readAnimeTextEvidence(record, label);
  } catch (_error) {
    return null;
  }
}

/**
 * @param {JsonRecord} target
 * @param {JsonRecord} record
 * @param {string} label
 */
function copyAnimeTextEvidence(target, record, label) {
  const evidence = readAnimeTextEvidence(record, label);
  if (evidence) {
    Object.assign(target, evidence);
  }
}

/** @param {unknown} value */
function readDetectorBox(value) {
  return Array.isArray(value) ? value.map(Number) : [];
}

/** @param {AnimeTextEvidence} evidence */
function isValidAnimeTextEvidence(evidence) {
  return (
    /^ATY\d{3,4}$/.test(evidence.animeTextRegionId) &&
    isUnitIntervalAtLeast(
      evidence.animeTextRegionScore,
      MIN_ANIME_TEXT_REGION_SCORE,
    ) &&
    isUnitIntervalAtLeast(
      evidence.animeTextContainment,
      MIN_ANIME_TEXT_CONTAINMENT,
    ) &&
    isValidDetectorBox(evidence.animeTextRegionBbox) &&
    evidence.animeTextEvidenceVersion === ANIME_TEXT_EVIDENCE_VERSION &&
    evidence.animeTextModelRevision === ANIME_TEXT_MODEL_REVISION
  );
}

/** @param {number} value @param {number} minimum */
function isUnitIntervalAtLeast(value, minimum) {
  return Number.isFinite(value) && value >= minimum && value <= 1;
}

/** @param {number[]} bbox */
function isValidDetectorBox(bbox) {
  return (
    bbox.length === 4 &&
    bbox.every(Number.isFinite) &&
    bbox[2] > bbox[0] &&
    bbox[3] > bbox[1]
  );
}

module.exports = {
  ANIME_TEXT_EVIDENCE_VERSION,
  ANIME_TEXT_MODEL_REVISION,
  MIN_ANIME_TEXT_CONTAINMENT,
  MIN_ANIME_TEXT_REGION_SCORE,
  copyAnimeTextEvidence,
  readAnimeTextEvidence,
  tryReadAnimeTextEvidence,
};
