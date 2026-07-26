// @ts-check

const { fail, unionTuples } = require("./group-only-review-values.cjs");

const GROUP_ONLY_PROMPT_CONTRACT_VERSION = 17;
const ROLES = ["body", "ruby"];

/** @typedef {import("./group-only-review-types").ReviewCandidate} ReviewCandidate */
/** @typedef {import("./group-only-review-types").ReviewPlan} ReviewPlan */

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

/** @param {ReviewPlan} plan */
function buildGroupOnlyReviewPromptFromPlan(plan) {
  const evidence = buildGroupOnlyReviewEvidence(plan);
  const animeTextInstructions = buildAnimeTextInstructions(plan);
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
    ...animeTextInstructions,
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

/** @param {ReviewPlan} plan */
function buildGroupOnlyReviewEvidence(plan) {
  const samePaddle = /** @type {Map<string,number[]>} */ (new Map());
  for (const candidate of plan.candidates) {
    if (!candidate.paddleGroup) continue;
    const ids = samePaddle.get(candidate.paddleGroup) ?? [];
    ids.push(candidate.id);
    samePaddle.set(candidate.paddleGroup, ids);
  }
  const byId = new Map(plan.candidates.map((item) => [item.id, item]));
  return {
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
}

/** @param {ReviewPlan} plan */
function buildAnimeTextInstructions(plan) {
  const relations = readAnimeTextRelations(plan);
  const instructions =
    relations.shared.length > 0
      ? [
          "Grouping evidence priority is: visible closed container boundary first, shared Paddle group second, anime-text-yolo auxiliary relation third, upstream fragment boundary last.",
          "A shared_anime_text_region is emitted only after detector coverage plus an independent scale-relative reading-start alignment gate between exactly one confirmed and one deferred fragment.",
          "The detector still has no balloon-boundary knowledge. First search the crop for an outline, compartment edge, caption border, or other separator between those fragments.",
          "For every shared_anime_text_region, begin with all listed candidateIds in one provisional group.",
          "Split that provisional group only when the crop shows a visible outline, compartment edge, caption border, or other separator between the listed confirmedFragment and deferredFragment boxes.",
          "Whitespace, a short single glyph, unequal text height, a line or column break, and a missing shared Paddle group are not visible separators.",
          "If a visible separator exists, keep the fragments apart regardless of the relation. If none exists, the listed candidateIds must share one final group.",
          "Before returning labels, explicitly recheck every shared_anime_text_region: either its listed candidateIds share one group, or a visible separator in the crop justifies keeping them apart.",
          "Never merge solely from detector coverage; the supplied alignment and your visual boundary check must both support the merge.",
        ]
      : [
          "Grouping evidence priority is: visible closed container boundary first, shared Paddle group second, upstream fragment boundary last.",
        ];
  if (relations.hardDistinct.length > 0) {
    instructions.push(
      "Each distinctAnimeTextRegionBarriers entry is a hard merge barrier: keep both listed fragments intact; their candidates must never share a final group.",
      "Recheck every hard barrier before returning, even when its fragments share a Paddle group or appear semantically related.",
    );
    if (
      relations.hardDistinct.some(
        (relation) => relation.internalPartitionKind === "reading_start_bands",
      )
    ) {
      instructions.push(
        "For a reading_start_bands entry, keep its two synthetic band fragments separate even though they share one Paddle group.",
      );
    }
  }
  if (relations.internalSplitPriors.length > 0) {
    instructions.push(
      "For strength=conservative_split_prior, the application has replaced one source fragment with two synthetic fragments; prefer keeping them separate.",
      "This internal split prior is not a hard boundary: merge the pair when the crop clearly shows one uninterrupted composition.",
    );
  }
  return instructions;
}

/** @param {ReviewPlan} plan */
function readAnimeTextRelations(plan) {
  const spatialRelations =
    plan.spatialRelations &&
    typeof plan.spatialRelations === "object" &&
    !Array.isArray(plan.spatialRelations)
      ? /** @type {Record<string,unknown>} */ (plan.spatialRelations)
      : {};
  const distinct = Array.isArray(
    spatialRelations.distinctAnimeTextRegionBarriers,
  )
    ? spatialRelations.distinctAnimeTextRegionBarriers.filter(isRecord)
    : [];
  return {
    shared: Array.isArray(spatialRelations.sharedAnimeTextRegions)
      ? spatialRelations.sharedAnimeTextRegions
      : [],
    hardDistinct: distinct.filter(
      (relation) => relation.strength === "conservative_merge_barrier",
    ),
    internalSplitPriors: distinct.filter(
      (relation) =>
        relation.strength === "conservative_split_prior" &&
        Boolean(relation.sourceFragmentId),
    ),
  };
}

/** @param {unknown} value */
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

module.exports = {
  GROUP_ONLY_PROMPT_CONTRACT_VERSION,
  GROUP_ONLY_REVIEW_ROLES: ROLES,
  buildGroupOnlyReviewPromptFromPlan,
  buildGroupOnlyReviewResponseFormat,
  buildGroupOnlyReviewSystemPrompt,
};
