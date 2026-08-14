// @ts-check

const { isRecord, semanticContractError } = require("./values.cjs");
const {
  readDistinctAnimeTextRegionBarrierCandidatePair,
} = require("./anime-text-distinct-region-plan.cjs");

const GROUP_ONLY_REVIEW_VERSION = 1;

/** @typedef {import("./group-only-review-types").Box} Box */
/** @typedef {import("./group-only-review-types").TupleBox} TupleBox */
/** @typedef {import("./group-only-review-types").ReviewRole} ReviewRole */
/** @typedef {import("./group-only-review-types").ReviewLabel} ReviewLabel */
/** @typedef {import("./group-only-review-types").UpstreamFragment} UpstreamFragment */
/** @typedef {import("./group-only-review-types").ReviewPlan} ReviewPlan */

/** @param {ReviewPlan} plan @param {ReviewLabel[]} labels */
function validateLabels(plan, labels) {
  const byId = new Map(
    plan.candidates.map((item, index) => [item.id, labels[index]]),
  );
  for (const fragment of plan.upstreamFragments) {
    const groups = fragment.candidateIds.map((id) => {
      const label = byId.get(id);
      if (!label) fail("candidate-coverage", `Candidate ${id} has no label.`);
      return label.group;
    });
    if (new Set(groups).size !== 1)
      fail("fragment-split", `Fragment ${fragment.fragment} was split.`);
  }
  validateDistinctAnimeTextRegionBarriers(plan, byId);
  const roles = /** @type {Map<number,Set<ReviewRole>>} */ (new Map());
  labels.forEach((label) => {
    const values = roles.get(label.group) ?? new Set();
    values.add(label.role);
    roles.set(label.group, values);
  });
  for (const [group, values] of roles)
    if (!values.has("body")) fail("ruby-only", `Group ${group} has no body.`);
}

/**
 * Reject a model grouping that crosses a fully-qualified detector barrier.
 * Malformed optional relations are ignored; only a recognized barrier whose
 * candidate sets exactly match two confirmed upstream fragments is enforced.
 *
 * @param {ReviewPlan} plan
 * @param {Map<number,ReviewLabel>} byId
 */
function validateDistinctAnimeTextRegionBarriers(plan, byId) {
  const relations = isRecord(plan.spatialRelations)
    ? plan.spatialRelations.distinctAnimeTextRegionBarriers
    : null;
  if (!Array.isArray(relations)) return;
  for (const relation of relations) {
    const pair = readDistinctAnimeTextRegionBarrierCandidatePair(
      plan,
      relation,
    );
    if (!pair) continue;
    const leftGroups = new Set(
      pair[0].map((id) => {
        const label = byId.get(id);
        if (!label) fail("candidate-coverage", `Candidate ${id} has no label.`);
        return label.group;
      }),
    );
    const rightGroups = new Set(
      pair[1].map((id) => {
        const label = byId.get(id);
        if (!label) fail("candidate-coverage", `Candidate ${id} has no label.`);
        return label.group;
      }),
    );
    if ([...leftGroups].some((group) => rightGroups.has(group))) {
      fail(
        "distinct-anime-text-region-merge",
        "Distinct anime-text regions must remain in separate groups.",
      );
    }
  }
}

/** @param {unknown} value @param {number[]} ids @returns {UpstreamFragment[]} */
function normalizeFragments(value, ids) {
  const raw =
    Array.isArray(value) && value.length
      ? value
      : ids.map((id) => ({ ids: [id] }));
  const valid = new Set(ids);
  const consumed = new Set();
  const fragments = raw.map((item, index) => {
    const source = record(item, `fragment ${index + 1}`);
    const candidateIds = integerArray(
      source.candidateIds ?? source.ids,
      "fragment ids",
    );
    for (const id of candidateIds) {
      if (!valid.has(id) || consumed.has(id))
        fail(
          "fragment-partition",
          `Unknown or duplicate fragment candidate ${id}.`,
        );
      consumed.add(id);
    }
    return {
      fragment:
        optionalString(source.fragment ?? source.group) ??
        `F${String(index + 1).padStart(3, "0")}`,
      status: optionalString(source.status) ?? "confirmed",
      candidateIds,
    };
  });
  if (consumed.size !== ids.length)
    fail(
      "fragment-coverage",
      "Fragments must cover every candidate exactly once.",
    );
  return fragments;
}

/** @param {string} text */
function assertNoDuplicateKeys(text) {
  let index = 0;
  const ws = () => {
    while (/\s/.test(text[index] ?? "")) index += 1;
  };
  const string = () => {
    if (text[index] !== '"') fail("json", "Expected JSON string.");
    const start = index++;
    while (index < text.length) {
      if (text[index] === "\\") index += 2;
      else if (text[index++] === '"')
        return JSON.parse(text.slice(start, index));
    }
    fail("json", "Unterminated JSON string.");
  };
  const value = () => {
    ws();
    if (text[index] === "{") return object();
    if (text[index] === "[") return array();
    if (text[index] === '"') return void string();
    const match = text
      .slice(index)
      .match(
        /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/,
      );
    if (!match) fail("json", "Invalid JSON value.");
    index += match[0].length;
  };
  const object = () => {
    const keys = new Set();
    index += 1;
    ws();
    if (text[index] === "}") return void (index += 1);
    while (index < text.length) {
      ws();
      const key = string();
      if (keys.has(key))
        fail("json-duplicate-key", `Duplicate JSON key ${key}.`);
      keys.add(key);
      ws();
      if (text[index++] !== ":") fail("json", "Missing JSON colon.");
      value();
      ws();
      if (text[index] === "}") return void (index += 1);
      if (text[index++] !== ",") fail("json", "Missing JSON comma.");
    }
  };
  const array = () => {
    index += 1;
    ws();
    if (text[index] === "]") return void (index += 1);
    while (index < text.length) {
      value();
      ws();
      if (text[index] === "]") return void (index += 1);
      if (text[index++] !== ",") fail("json", "Missing JSON comma.");
    }
  };
  value();
  ws();
  if (index !== text.length) fail("json", "Unexpected content after JSON.");
}

/** @param {unknown} value @returns {string} */
function normalizeEnvelope(value) {
  return String(value ?? "")
    .trim()
    .replace(/^(?:<\|start\|>\s*assistant|<start_of_turn>\s*model)\s*/i, "")
    .replace(
      /^<\|channel\|?>(?:thought|analysis|final)\s*(?:<channel\|>|<\|message\|?>)\s*/i,
      "",
    )
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(
      /\s*(?:<\|end\|>|<\|end_of_turn\|>|<end_of_turn>|<\|eot_id\|>)\s*$/i,
      "",
    )
    .trim();
}

/** @param {Record<string,unknown>} value @param {string} label @returns {Box} */
function pixelBox(value, label) {
  const nested = isRecord(value.pageBbox)
    ? value.pageBbox
    : isRecord(value.bbox)
      ? value.bbox
      : value;
  const array = Array.isArray(value.bbox) ? value.bbox : null;
  const bbox = array
    ? {
        x1: Number(array[0]),
        y1: Number(array[1]),
        x2: Number(array[2]),
        y2: Number(array[3]),
      }
    : {
        x1: Number(nested.x1),
        y1: Number(nested.y1),
        x2: Number(nested.x2),
        y2: Number(nested.y2),
      };
  if (
    !Object.values(bbox).every(Number.isFinite) ||
    bbox.x2 <= bbox.x1 ||
    bbox.y2 <= bbox.y1
  )
    fail("bbox", `${label} has an invalid bbox.`);
  return bbox;
}

/** @param {unknown} value @returns {Box|null} */
function optionalBox(value) {
  if (!isRecord(value)) return null;
  const bbox = {
    x1: Number(value.x1),
    y1: Number(value.y1),
    x2: Number(value.x2),
    y2: Number(value.y2),
  };
  return Object.values(bbox).every(Number.isFinite) &&
    bbox.x2 > bbox.x1 &&
    bbox.y2 > bbox.y1
    ? bbox
    : null;
}

/** @param {unknown} value @returns {TupleBox|null} */
function tupleBox(value) {
  return Array.isArray(value) &&
    value.length === 4 &&
    value.every(Number.isFinite) &&
    value[2] > value[0] &&
    value[3] > value[1]
    ? /** @type {TupleBox} */ (value.map(Number))
    : null;
}

/** @param {TupleBox[]} boxes @returns {TupleBox} */
function unionTuples(boxes) {
  return [
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3])),
  ];
}

/** @param {Box} box @param {Box} crop @returns {TupleBox} */
function toCrop1000(box, crop) {
  const x = crop.x2 - crop.x1;
  const y = crop.y2 - crop.y1;
  /** @param {number} number */
  const clamp = (number) => Math.max(0, Math.min(1000, number));
  return [
    clamp(Math.floor(((box.x1 - crop.x1) / x) * 1000)),
    clamp(Math.floor(((box.y1 - crop.y1) / y) * 1000)),
    clamp(Math.ceil(((box.x2 - crop.x1) / x) * 1000)),
    clamp(Math.ceil(((box.y2 - crop.y1) / y) * 1000)),
  ];
}

/** @param {unknown} value @param {string} label @param {boolean} [allowEmpty] @returns {number[]} */
function integerArray(value, label, allowEmpty = false) {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && !value.length) ||
    value.some((id) => !positive(id)) ||
    new Set(value).size !== value.length
  )
    fail("id-array", `${label} must contain unique positive integers.`);
  return value.map(Number);
}

/** @param {Record<string,unknown>} value @param {string[]} wanted @param {string} label */
function exactKeys(value, wanted, label) {
  if (Object.keys(value).sort().join("\0") !== [...wanted].sort().join("\0"))
    fail("fields", `${label} has extra or missing fields.`);
}

/** @param {unknown} value @param {string} label @returns {Record<string,unknown>} */
function record(value, label) {
  if (!isRecord(value)) fail("record", `${label} must be an object.`);
  return value;
}

/** @param {unknown} value @returns {number|null} */
function positive(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/** @param {unknown} value @returns {string|null} */
function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** @param {unknown} value @returns {value is ReviewPlan} */
function isPlan(value) {
  return (
    isRecord(value) &&
    value.version === GROUP_ONLY_REVIEW_VERSION &&
    Array.isArray(value.candidates) &&
    Array.isArray(value.upstreamFragments)
  );
}

/** @param {unknown} error @returns {Record<string,unknown>} */
function describeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    ...(isRecord(error) && typeof error.code === "string"
      ? { code: error.code }
      : {}),
  };
}

/** @param {string} suffix @param {string} message @returns {never} */
function fail(suffix, message) {
  throw semanticContractError(`group-only-review-${suffix}`, message);
}

module.exports = {
  GROUP_ONLY_REVIEW_VERSION,
  assertNoDuplicateKeys,
  describeError,
  exactKeys,
  fail,
  integerArray,
  isPlan,
  normalizeEnvelope,
  normalizeFragments,
  optionalBox,
  optionalString,
  pixelBox,
  positive,
  record,
  toCrop1000,
  tupleBox,
  unionTuples,
  validateLabels,
};
