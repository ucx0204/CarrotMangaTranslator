// @ts-check
/* eslint-disable max-lines -- the v10 prompt, parser, and projection stay together as one frozen contract */

const { readOcrCandidateText } = require("../prompts/ocr-text.cjs");
const { isRecord, semanticContractError } = require("./values.cjs");

const GROUP_ONLY_REVIEW_VERSION = 1;
const GROUP_ONLY_PROMPT_CONTRACT_VERSION = 10;
const ROLES = ["body", "ruby"];

/**
 * @typedef {{x1:number;y1:number;x2:number;y2:number}} Box
 * @typedef {[number,number,number,number]} TupleBox
 * @typedef {"body"|"ruby"} ReviewRole
 * @typedef {"model"|"upstream-fallback"|"singleton"} ReviewSource
 * @typedef {{group:number;role:ReviewRole}} ReviewLabel
 * @typedef {{id:number;index:number;hint:Record<string,unknown>;bbox:Box;text:string;score:number|null;bbox1000:TupleBox;paddleGroup:string|null;paddleOrder:number|null}} ReviewCandidate
 * @typedef {{fragment:string;status:string;candidateIds:number[]}} UpstreamFragment
 * @typedef {{version:number;reviewCase:Record<string,unknown>;region:Record<string,unknown>;candidates:ReviewCandidate[];candidateOrder:number[];upstreamFragments:UpstreamFragment[];spatialRelations:Record<string,unknown>}} ReviewPlan
 * @typedef {{localGroupIndex:number;modelGroup:number|null;candidateIds:number[];bodyCandidateIds:number[];rubyCandidateIds:number[];jp:string;bbox:Box}} ReviewedGroup
 * @typedef {{source:ReviewSource;labels:ReviewLabel[];groups:ReviewedGroup[];candidateOrder:number[]}} ReviewProjection
 * @typedef {ReviewProjection & {status:"reviewed"|"fallback"|"singleton";usedFallback:boolean;requestSkipped:boolean;rawResponse:unknown;fallbackError?:Record<string,unknown>}} ReviewResult
 * @typedef {{groupId:string;orderInGroup:number;groupSize:number;reviewRole:ReviewRole}} HintAssignment
 */

function buildGroupOnlyReviewSystemPrompt() {
  return [
    "You conservatively group already-detected Japanese manga OCR candidates.",
    "This is grouping only: never transcribe, correct, or output text or coordinates.",
    "A group is one enclosing balloon, card, caption, or continuous printed composition; line and column boundaries alone never define groups.",
    "Small visible furigana must attach to its host group as rubyIds; it must never become a standalone group.",
    "First identify visible closed balloon or panel compartments. Never merge upstream fragments that belong to different closed compartments, even when they touch and share a Paddle group.",
    "Only after preserving those hard visible boundaries, use Paddle groups to join fragments inside one compartment.",
    "The supplied upstream fragments guarantee candidate coverage but are not final group boundaries.",
    "Never preserve a fragment boundary merely because it was supplied.",
    "This pass may merge upstream fragments but must never split one.",
    "This pass must keep every supplied candidate; noise removal belongs to a later audit.",
    "When unsure, prefer the shared Paddle group unless a visible boundary contradicts it.",
    "Return exactly one label for every supplied candidate, in the supplied order.",
    "Return only the schema-constrained JSON object.",
  ].join("\n");
}

/** @param {ReviewPlan | Record<string,unknown>} value @param {Record<string,unknown>} [region] @returns {string} */
function buildGroupOnlyReviewPrompt(value, region = {}) {
  const plan = isPlan(value) ? value : buildGroupOnlyReviewPlan(value, region);
  const samePaddle = /** @type {Map<string,number[]>} */ (new Map());
  for (const candidate of plan.candidates) {
    if (!candidate.paddleGroup) continue;
    const ids = samePaddle.get(candidate.paddleGroup) ?? [];
    ids.push(candidate.id);
    samePaddle.set(candidate.paddleGroup, ids);
  }
  const byId = new Map(plan.candidates.map((item) => [item.id, item]));
  const evidence = {
    upstreamFragments: plan.upstreamFragments.map((fragment) => {
      const members = /** @type {ReviewCandidate[]} */ (
        fragment.candidateIds.map((id) => byId.get(id))
      );
      return {
        fragment: fragment.fragment,
        status: fragment.status,
        ids: fragment.candidateIds,
        text: members.map((item) => item.text).join(""),
        bbox1000: unionTuples(members.map((item) => item.bbox1000)),
      };
    }),
    candidates: plan.candidates.map((item) => ({
      id: item.id,
      text: item.text,
      score: item.score,
      bbox1000: item.bbox1000,
      paddleGroup: item.paddleGroup,
      paddleOrder: item.paddleOrder,
    })),
    samePaddleGroupSets: [...samePaddle].map(([paddleGroup, ids]) => ({
      paddleGroup,
      ids,
    })),
    spatialRelations: plan.spatialRelations,
  };
  return [
    "# Existing OCR evidence",
    JSON.stringify(evidence),
    "",
    "# Grouping-only task",
    `candidateOrder=[${plan.candidateOrder.join(",")}].`,
    `Return exactly ${plan.candidateOrder.length} labels. labels[i] classifies candidateOrder[i].`,
    "For visible text, group is an integer from 1 through the candidate count. Candidates with the same group number form one final group.",
    'role is "body" for main printed text or "ruby" for visibly smaller furigana that reads nearby main text.',
    "Every candidate must use a nonzero group and one of those two roles. Do not discard candidates in this pass.",
    "Do not output text. Do not correct OCR text. Do not output or propose coordinates.",
    "The application will derive each group's bbox by the exact union of its Paddle boxes.",
    "First decide the visible enclosing composition for every candidate; only then classify body versus ruby.",
    "Grouping evidence priority is: visible closed container boundary first, shared Paddle group second, upstream fragment boundary last.",
    "A group means all text inside one enclosing balloon, card, caption plate, or continuous printed composition.",
    "A single line may be a complete group when it is its own balloon, card, caption, or independent composition.",
    "Do not split one composition merely because of whitespace, line breaks, vertical columns, horizontal rows, staggered placement, or ruby gaps.",
    "A clearly visible boundary between separate balloons, cards, or unrelated printed compositions does require separate groups.",
    "Do not merge separate containers merely because their text is nearby, diagonal, or forms one sentence.",
    "upstreamFragments guarantee coverage only. Separate fragments are not evidence of separate final groups.",
    "confirmed means the fragment's internal association is useful, not that it is a complete container; confirmed fragments may be merged.",
    "deferred fragments are explicitly unresolved and must not be preserved as standalone groups merely because they are separate.",
    "Every candidate visibly printed inside one uninterrupted balloon, card, caption, or text panel must share that composition's group even when paddleGroup is null, confidence is low, or the OCR text guess is nonsense.",
    "Never isolate a visible fragment merely because its OCR text does not fit the surrounding sentence.",
    "Candidates sharing the same non-null paddleGroup normally use the same final group.",
    "Override that hint when the image shows separate closed balloon lobes, separate outline compartments, a real enclosing border, or a clearly disconnected sound-effect composition.",
    "Touching or connected balloons still remain separate when each lobe has its own visible outline compartment.",
    "Whitespace, diagonal placement, a new line, or a new column is not enough to override a shared paddleGroup.",
    "Classify every candidate's role again from its visible size and location; currentGroups and Paddle text do not establish body versus ruby.",
    "Small-candidate OCR guesses are often wrong. A visibly small reading beside or above main kanji is ruby even when its OCR guess looks like kanji or nonsense.",
    'Give such furigana the host body candidate\'s group and role="ruby", even if currentGroups listed it separately or as body.',
    "Every nonzero group must contain at least one body candidate; furigana must never form a standalone group.",
    "Do not label ordinary small body text, punctuation, sound effects, or unrelated marks as ruby.",
    "Keep even a suspected duplicate in its host group; a later OCR audit can remove noise without risking lost text.",
    "Never split a supplied upstream fragment. This pass only merges fragments and assigns body/ruby roles.",
    "Mandatory final check 1: do not merge upstream fragments from visibly different closed balloon or panel compartments, even if their Paddle group matches.",
    "Mandatory final check 2: after preserving those hard boundaries, unify non-discarded IDs in each samePaddleGroupSets entry that remain inside one compartment.",
    "Before returning, verify that labels has exactly one entry per candidateOrder item and that each nonzero group has a body.",
    "If uncertain, keep each upstream fragment intact, merge fragments sharing a Paddle group unless a visible boundary contradicts it, and classify only unmistakable furigana as ruby.",
  ].join("\n");
}

/** @param {number} count @returns {Record<string,unknown>} */
function buildGroupOnlyReviewResponseFormat(count) {
  if (!Number.isInteger(count) || count < 1)
    fail("candidate-count", "Candidate count must be positive.");
  return {
    type: "json_object",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["labels"],
      properties: { labels: labelArraySchema(count) },
    },
  };
}

/** @param {number} count @returns {Record<string,unknown>} */
function labelArraySchema(count) {
  return {
    type: "array",
    minItems: count,
    maxItems: count,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["group", "role"],
      properties: {
        group: { type: "integer", minimum: 1, maximum: count },
        role: { type: "string", enum: ROLES },
      },
    },
  };
}

/**
 * candidates/hints is the canonical raw Paddle-hint array in exact model and
 * reading order. Original Paddle evidence is read only from sidecar fields
 * paddleGroupId/paddleOrder, never from a final groupId.
 * @param {Record<string,unknown>} reviewCase
 * @param {Record<string,unknown>} [region]
 * @returns {ReviewPlan}
 */
function buildGroupOnlyReviewPlan(reviewCase, region = {}) {
  record(reviewCase, "review case");
  record(region, "review region");
  const raw = /** @type {unknown[]} */ (
    Array.isArray(reviewCase.candidates)
      ? reviewCase.candidates
      : reviewCase.hints
  );
  if (!Array.isArray(raw) || !raw.length)
    fail("candidates", "Candidates must be a non-empty array.");
  const seen = new Set();
  const prelim = raw.map((value, index) => {
    const hint = record(value, `candidate ${index + 1}`);
    const id = positive(hint.id);
    if (!id || seen.has(id))
      fail(
        "candidate-id",
        `Candidate ${index + 1} needs a unique positive id.`,
      );
    seen.add(id);
    return { id, index, hint, bbox: pixelBox(hint, `candidate ${id}`) };
  });
  const crop =
    optionalBox(region.cropBbox ?? region.bbox ?? region) ??
    unionBoxes(prelim.map((item) => item.bbox));
  const candidates = prelim.map((item) => ({
    ...item,
    text: readOcrCandidateText(item.hint),
    score: Number.isFinite(Number(item.hint.score))
      ? Number(item.hint.score)
      : null,
    bbox1000: tupleBox(item.hint.bbox1000) ?? toCrop1000(item.bbox, crop),
    paddleGroup: optionalString(
      item.hint.paddleGroupId ?? item.hint.paddleGroup,
    ),
    paddleOrder: positive(item.hint.paddleOrder),
  }));
  const candidateOrder = candidates.map((item) => item.id);
  if (
    reviewCase.candidateOrder !== undefined &&
    JSON.stringify(reviewCase.candidateOrder) !== JSON.stringify(candidateOrder)
  ) {
    fail("candidate-order", "candidateOrder must exactly match candidates.");
  }
  const upstreamFragments = normalizeFragments(
    reviewCase.upstreamFragments ?? reviewCase.currentGroups,
    candidateOrder,
  );
  return {
    version: GROUP_ONLY_REVIEW_VERSION,
    reviewCase,
    region,
    candidates,
    candidateOrder,
    upstreamFragments,
    spatialRelations: isRecord(reviewCase.spatialRelations)
      ? reviewCase.spatialRelations
      : {},
  };
}

/** @param {string} rawText @param {ReviewPlan} plan @returns {ReviewProjection} */
function parseGroupOnlyReviewResponse(rawText, plan) {
  if (!isPlan(plan)) fail("plan", "A validated group-only plan is required.");
  const text = normalizeEnvelope(rawText);
  assertNoDuplicateKeys(text);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw semanticContractError(
      "group-only-review-json",
      "Invalid group-only JSON.",
      { cause: error },
    );
  }
  const response = record(parsed, "response");
  exactKeys(response, ["labels"], "response");
  if (
    !Array.isArray(response.labels) ||
    response.labels.length !== plan.candidates.length
  ) {
    fail(
      "label-count",
      `Exactly ${plan.candidates.length} labels are required.`,
    );
  }
  const labels = response.labels.map((value, index) => {
    const label = record(value, `label ${index + 1}`);
    exactKeys(label, ["group", "role"], `label ${index + 1}`);
    const group = Number(label.group);
    if (
      !Number.isInteger(label.group) ||
      group < 1 ||
      group > plan.candidates.length
    ) {
      fail("group", `Invalid group at label ${index + 1}.`);
    }
    if (!ROLES.includes(String(label.role)))
      fail("role", `Invalid role at label ${index + 1}.`);
    return { group, role: /** @type {ReviewRole} */ (label.role) };
  });
  validateLabels(plan, labels);
  return projectGroupOnlyReviewLabels(plan, labels, "model");
}

/** @param {ReviewPlan} plan @returns {ReviewProjection} */
function buildGroupOnlyReviewFallback(plan) {
  if (!isPlan(plan)) fail("plan", "A validated group-only plan is required.");
  const groupById = /** @type {Map<number,number>} */ (new Map());
  plan.upstreamFragments.forEach((fragment, index) => {
    fragment.candidateIds.forEach((id) => groupById.set(id, index + 1));
  });
  const labels = plan.candidates.map((item) => ({
    group: Number(groupById.get(item.id)),
    role: /** @type {"body"} */ ("body"),
  }));
  return projectGroupOnlyReviewLabels(plan, labels, "upstream-fallback");
}

/** @param {ReviewPlan} plan @param {ReviewLabel[]} labels @param {ReviewSource} source @returns {ReviewProjection} */
function projectGroupOnlyReviewLabels(plan, labels, source) {
  if (labels.length !== plan.candidates.length)
    fail("label-count", "Label count does not match candidates.");
  const buckets =
    /** @type {Map<number,Array<{candidate:ReviewCandidate;role:ReviewRole}>>} */ (
      new Map()
    );
  plan.candidates.forEach((candidate, index) => {
    const label = labels[index];
    const members = buckets.get(label.group) ?? [];
    members.push({ candidate, role: label.role });
    buckets.set(label.group, members);
  });
  const ordered = [...buckets].sort(
    (left, right) =>
      Math.min(...left[1].map((item) => item.candidate.id)) -
      Math.min(...right[1].map((item) => item.candidate.id)),
  );
  const groups = ordered.map(([modelGroup, members], index) => {
    const body = members.filter((item) => item.role === "body");
    const ruby = members.filter((item) => item.role === "ruby");
    if (!body.length) fail("ruby-only", `Group ${modelGroup} has no body.`);
    return {
      localGroupIndex: index + 1,
      modelGroup: source === "model" ? modelGroup : null,
      // Keep lexical body rows first and attach ruby afterwards. This matches
      // the accepted v10 projection while preserving the original order
      // within each role; JP is still derived from body rows only.
      candidateIds: [...body, ...ruby].map((item) => item.candidate.id),
      bodyCandidateIds: body.map((item) => item.candidate.id),
      rubyCandidateIds: ruby.map((item) => item.candidate.id),
      jp: body.map((item) => item.candidate.text).join(""),
      bbox: unionBoxes(members.map((item) => item.candidate.bbox)),
    };
  });
  return {
    source,
    labels: labels.map((item) => ({ ...item })),
    groups,
    candidateOrder: [...plan.candidateOrder],
  };
}

/**
 * Applies crop results in crop/group order and issues page-global G001..Gnnn.
 * Every page hint must occur exactly once across results. Singleton hints keep
 * reviewRole but intentionally need no semantic group metadata.
 * @param {Record<string,unknown>[]} pageHints
 * @param {ReviewProjection[]} cropResults
 * @param {{validatedGroupOnlyReview?:boolean}} [options]
 * @returns {{hints:Record<string,unknown>[];groupOnlyReviewVersion:number;validatedGroupOnlyReview:boolean;reviewedGroupCount:number}}
 */
function applyReviewedGroupsToHints(pageHints, cropResults, options = {}) {
  if (!Array.isArray(pageHints) || !Array.isArray(cropResults))
    fail("apply-input", "Hints and crop results must be arrays.");
  const hintById = /** @type {Map<number,Record<string,unknown>>} */ (
    new Map()
  );
  pageHints.forEach((hint, index) => {
    const raw = record(hint, `page hint ${index + 1}`);
    const id = positive(raw.id);
    if (!id || hintById.has(id))
      fail("apply-hint-id", "Page hint ids must be unique.");
    hintById.set(id, raw);
  });
  const assignment = /** @type {Map<number,HintAssignment>} */ (new Map());
  let groupNumber = 0;
  for (const result of cropResults) {
    for (const rawGroup of result.groups) {
      const group = record(rawGroup, "reviewed group");
      const ids = integerArray(group.candidateIds, "candidateIds");
      const body = new Set(
        integerArray(group.bodyCandidateIds, "bodyCandidateIds"),
      );
      const ruby = new Set(
        integerArray(group.rubyCandidateIds, "rubyCandidateIds", true),
      );
      if (!body.size || ids.length !== body.size + ruby.size)
        fail("apply-group", "Reviewed group partition is invalid.");
      groupNumber += 1;
      const groupId = `G${String(groupNumber).padStart(3, "0")}`;
      ids.forEach((id, index) => {
        const role = body.has(id) ? "body" : ruby.has(id) ? "ruby" : "";
        if (!role || !hintById.has(id) || assignment.has(id))
          fail("apply-partition", `Candidate ${id} is missing or duplicated.`);
        assignment.set(id, {
          groupId,
          orderInGroup: index + 1,
          groupSize: ids.length,
          reviewRole: role,
        });
      });
    }
  }
  if (assignment.size !== hintById.size)
    fail(
      "apply-coverage",
      "Crop results must cover every page hint exactly once.",
    );
  const hints = pageHints.map((raw) => {
    const hint = { ...raw };
    delete hint.groupId;
    delete hint.orderInGroup;
    delete hint.groupSize;
    delete hint.semanticGroup;
    delete hint.rolePrior;
    delete hint.containerType;
    const id = positive(hint.id);
    if (!id) fail("apply-hint-id", "Final hint id is invalid.");
    const meta = assignment.get(id);
    if (!meta) fail("apply-coverage", "Missing final hint assignment.");
    hint.reviewRole = meta.reviewRole;
    if (meta.groupSize > 1)
      Object.assign(hint, {
        groupId: meta.groupId,
        orderInGroup: meta.orderInGroup,
        groupSize: meta.groupSize,
        semanticGroup: true,
        rolePrior: "ordinary_mergeable",
        containerType: "same_text_container",
      });
    return hint;
  });
  return {
    hints,
    groupOnlyReviewVersion: GROUP_ONLY_REVIEW_VERSION,
    validatedGroupOnlyReview:
      options.validatedGroupOnlyReview ??
      cropResults.every((result) => result.source !== "upstream-fallback"),
    reviewedGroupCount: groupNumber,
  };
}

/**
 * Injected request returns raw JSON or {outputText,rawResponse?}. All failures
 * except AbortError fail open to the exact upstream-fragment partition.
 * @param {Record<string,unknown>} reviewCase
 * @param {Record<string,unknown>} region
 * @param {(request:Record<string,unknown>)=>Promise<string|{outputText:string;rawResponse?:unknown}>} requestReview
 * @returns {Promise<ReviewResult>}
 */
async function reviewGroupOnlyCrop(reviewCase, region, requestReview) {
  const plan = buildGroupOnlyReviewPlan(reviewCase, region);
  if (plan.candidates.length === 1) {
    return {
      status: "singleton",
      usedFallback: false,
      requestSkipped: true,
      ...projectGroupOnlyReviewLabels(
        plan,
        [{ group: 1, role: "body" }],
        "singleton",
      ),
      rawResponse: null,
    };
  }
  try {
    if (typeof requestReview !== "function")
      fail("request", "A request callback is required.");
    const response = await requestReview({
      case: reviewCase,
      region,
      candidateOrder: [...plan.candidateOrder],
      systemPrompt: buildGroupOnlyReviewSystemPrompt(),
      prompt: buildGroupOnlyReviewPrompt(plan),
      responseFormat: buildGroupOnlyReviewResponseFormat(
        plan.candidates.length,
      ),
    });
    const outputText =
      typeof response === "string" ? response : response?.outputText;
    if (!outputText)
      fail("empty-response", "Group-only review returned no JSON.");
    return {
      status: "reviewed",
      usedFallback: false,
      requestSkipped: false,
      ...parseGroupOnlyReviewResponse(outputText, plan),
      rawResponse:
        typeof response === "string"
          ? response
          : (response.rawResponse ?? response),
    };
  } catch (error) {
    const abortError = /** @type {Error & {code?:unknown}} */ (error);
    if (
      error instanceof Error &&
      (error.name === "AbortError" || abortError.code === "ABORT_ERR")
    )
      throw error;
    return {
      status: "fallback",
      usedFallback: true,
      requestSkipped: false,
      ...buildGroupOnlyReviewFallback(plan),
      rawResponse: null,
      fallbackError: describeError(error),
    };
  }
}

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
  const roles = /** @type {Map<number,Set<ReviewRole>>} */ (new Map());
  labels.forEach((label) => {
    const values = roles.get(label.group) ?? new Set();
    values.add(label.role);
    roles.set(label.group, values);
  });
  for (const [group, values] of roles)
    if (!values.has("body")) fail("ruby-only", `Group ${group} has no body.`);
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

/** @param {Box[]} boxes @returns {Box} */
function unionBoxes(boxes) {
  return {
    x1: Math.min(...boxes.map((b) => b.x1)),
    y1: Math.min(...boxes.map((b) => b.y1)),
    x2: Math.max(...boxes.map((b) => b.x2)),
    y2: Math.max(...boxes.map((b) => b.y2)),
  };
}

/** @param {TupleBox[]} boxes @returns {TupleBox} */
function unionTuples(boxes) {
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}

/** @param {Box} box @param {Box} crop @returns {TupleBox} */
function toCrop1000(box, crop) {
  const x = crop.x2 - crop.x1;
  const y = crop.y2 - crop.y1;
  /** @param {number} n */
  const clamp = (n) => Math.max(0, Math.min(1000, n));
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
  GROUP_ONLY_PROMPT_CONTRACT_VERSION,
  GROUP_ONLY_REVIEW_VERSION,
  applyReviewedGroupsToHints,
  buildGroupOnlyReviewFallback,
  buildGroupOnlyReviewPlan,
  buildGroupOnlyReviewPrompt,
  buildGroupOnlyReviewResponseFormat,
  buildGroupOnlyReviewSystemPrompt,
  parseGroupOnlyReviewResponse,
  reviewGroupOnlyCrop,
};
