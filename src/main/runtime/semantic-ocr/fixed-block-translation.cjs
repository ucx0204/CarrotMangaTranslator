// @ts-check

/**
 * Final translation contract for the common semantic OCR path.
 *
 * OCR and the group-only crop review already own candidate membership and geometry.
 * This module gives the translator only opaque block ids and accepts only
 * transcription/translation text back. The model cannot recreate coordinates,
 * candidate ids, or groups.
 */

const {
  buildSemanticCandidates,
  isCommonSemanticOcrMode,
} = require("./candidates.cjs");
const {
  projectSemanticGroupOutputSlots,
} = require("../prompts/ocr-semantic-slots.cjs");
const { readOcrCandidateText } = require("../prompts/ocr-text.cjs");
const {
  isJapaneseLanguageCode,
  resolvePromptLanguageProfile,
} = require("../simple-page-language-profile.cjs");
const { buildWorkContextSection } = require("../prompts/work-context.cjs");
const {
  cleanText,
  isRecord,
  parseJsonObject,
  positiveInteger,
  semanticContractError,
} = require("./values.cjs");

const FIXED_BLOCK_TRANSLATION_VERSION = 4;

/**
 * @typedef {{id:number;bbox:[number,number,number,number];text:string;score:number|null;orientation:"horizontal"|"vertical";soundCandidate:boolean}} FixedCandidate
 * @typedef {{blockId:string;representativeId:number;candidateIds:number[];jp:string;direction:"horizontal"|"vertical";bbox:{x1:number;y1:number;x2:number;y2:number};confidence:number;soundCandidate:boolean;fragments:Array<{candidateId:number;text:string;score:number|null;bbox:[number,number,number,number]}>}} FixedBlock
 * @typedef {{version:4;blocks:FixedBlock[]}} FixedBlockPlan
 * @typedef {{blockId:string;ko:string}} FixedBlockTranslation
 * @typedef {{items:FixedBlockTranslation[];pageContext?:Record<string,unknown>}} FixedBlockTranslationResult
 * @typedef {{sourceLanguage?:unknown;targetLanguage?:unknown;modelProvider?:unknown;regionCropMode?:unknown;keepBlocksMode?:unknown;promptOverrideText?:unknown;translationAttempt?:unknown;collectPageContext?:unknown;ocrBboxHints?:unknown;validatedGroupOnlyReview?:unknown;[key:string]:unknown}} FixedBlockOptions
 * @typedef {{role:string;dataUrl?:string;width?:unknown;height?:unknown;originalWidth?:unknown;originalHeight?:unknown;[key:string]:unknown}} ImageVariant
 */

/** @param {FixedBlockOptions} options */
function shouldUseFixedBlockTranslation(options = {}) {
  return (
    isGroupOnlyReviewEligible(options) &&
    options.validatedGroupOnlyReview === true
  );
}

/**
 * Shared activation predicate for the deterministic heuristic + group-only
 * review path and its immutable translation contract. Keeping this in one
 * place prevents the two stages from silently drifting apart.
 *
 * @param {FixedBlockOptions} options
 */
function isGroupOnlyReviewEligible(options = {}) {
  const hints = Array.isArray(options.ocrBboxHints) ? options.ocrBboxHints : [];
  return [
    String(options.modelProvider ?? "gemma")
      .trim()
      .toLowerCase() === "gemma",
    isCommonSemanticOcrMode(options),
    !options.regionCropMode,
    !options.keepBlocksMode,
    !String(options.promptOverrideText ?? "").trim(),
    isJapaneseLanguageCode(options.sourceLanguage),
    hints.length > 0,
  ].every(Boolean);
}

/** @param {FixedBlockOptions} options */
function hasHeuristicReviewFragments(options = {}) {
  const hints = Array.isArray(options.ocrBboxHints) ? options.ocrBboxHints : [];
  return (
    hints.length > 0 &&
    hints.every(
      (hint) =>
        isRecord(hint) &&
        /^B\d{3,4}$|^D\d{3,4}$/u.test(
          String(hint.reviewFragmentId ?? "").trim(),
        ) &&
        (hint.reviewStatus === "confirmed" || hint.reviewStatus === "deferred"),
    )
  );
}

/**
 * Build one immutable output block for every projected semantic group or
 * surviving singleton. `projectSemanticGroupOutputSlots` is the existing
 * completeness validator: malformed/incomplete groups remain singletons.
 *
 * @param {FixedBlockOptions} options
 * @param {ImageVariant[]} imageVariants
 * @returns {FixedBlockPlan}
 */
function buildFixedBlockPlan(options, imageVariants = []) {
  const hints = Array.isArray(options.ocrBboxHints)
    ? /** @type {Record<string,unknown>[]} */ (options.ocrBboxHints)
    : [];
  const candidates = /** @type {FixedCandidate[]} */ (
    buildSemanticCandidates(options, imageVariants)
  );
  const candidateById = new Map(
    candidates.map((candidate) => [candidate.id, candidate]),
  );
  const projected = projectSemanticGroupOutputSlots(
    hints,
    /** @type {import("../prompts/prompt-types").PromptOptions} */ (options),
  );
  /** @type {FixedCandidate[][]} */
  const memberGroups = [];
  /** @type {Map<number,string>} */
  const sourceTextById = new Map();
  /** @type {Map<number,"body"|"ruby">} */
  const reviewRoleById = new Map();
  const emittedCandidateIds = new Set();

  for (const slot of projected) {
    const sourceMembers = Array.isArray(slot.fragmentHints)
      ? slot.fragmentHints
      : [slot];
    const members = sourceMembers.flatMap((hint) => {
      const id = positiveInteger(hint?.id);
      const candidate = id ? candidateById.get(id) : undefined;
      if (!candidate || emittedCandidateIds.has(candidate.id)) return [];
      sourceTextById.set(candidate.id, readOcrCandidateText(hint));
      reviewRoleById.set(
        candidate.id,
        hint.reviewRole === "ruby" ? "ruby" : "body",
      );
      return [candidate];
    });
    if (members.length === 0) continue;
    for (const member of members) emittedCandidateIds.add(member.id);
    memberGroups.push(members);
  }

  // Projection is deliberately lossless, but retain any future lexical
  // candidate unknown to that helper as a fixed singleton rather than losing
  // source text.
  for (const candidate of candidates) {
    if (emittedCandidateIds.has(candidate.id)) continue;
    emittedCandidateIds.add(candidate.id);
    const sourceHint = hints.find(
      (hint) => positiveInteger(hint?.id) === candidate.id,
    );
    sourceTextById.set(
      candidate.id,
      sourceHint ? readOcrCandidateText(sourceHint) : candidate.text,
    );
    reviewRoleById.set(
      candidate.id,
      sourceHint?.reviewRole === "ruby" ? "ruby" : "body",
    );
    memberGroups.push([candidate]);
  }

  return {
    version: FIXED_BLOCK_TRANSLATION_VERSION,
    blocks: memberGroups.map((members, index) =>
      buildFixedBlock(members, index, sourceTextById, reviewRoleById),
    ),
  };
}

/**
 * @param {FixedCandidate[]} members
 * @param {number} index
 * @param {Map<number,string>} sourceTextById
 * @param {Map<number,"body"|"ruby">} reviewRoleById
 * @returns {FixedBlock}
 */
function buildFixedBlock(members, index, sourceTextById, reviewRoleById) {
  const scores = members
    .map((candidate) => candidate.score)
    .filter((score) => score !== null);
  const bodyMembers = members.filter(
    (candidate) => reviewRoleById.get(candidate.id) !== "ruby",
  );
  const lexicalMembers = bodyMembers.length > 0 ? bodyMembers : members;
  return {
    blockId: `B${String(index + 1).padStart(3, "0")}`,
    representativeId: Math.min(...members.map((candidate) => candidate.id)),
    candidateIds: members.map((candidate) => candidate.id),
    jp: lexicalMembers
      .map(
        (candidate) =>
          sourceTextById.get(candidate.id) ?? String(candidate.text ?? ""),
      )
      .join(""),
    direction: resolveDirection(members),
    bbox: {
      x1: Math.min(...members.map((candidate) => candidate.bbox[0])),
      y1: Math.min(...members.map((candidate) => candidate.bbox[1])),
      x2: Math.max(...members.map((candidate) => candidate.bbox[2])),
      y2: Math.max(...members.map((candidate) => candidate.bbox[3])),
    },
    confidence:
      scores.length > 0
        ? Math.round(
            (scores.reduce((sum, score) => sum + Number(score), 0) /
              scores.length) *
              1000,
          ) / 1000
        : 0.75,
    soundCandidate: members.length === 1 && members[0]?.soundCandidate === true,
    fragments: members.map((candidate) => ({
      candidateId: candidate.id,
      text: candidate.text,
      score: candidate.score,
      bbox: candidate.bbox,
    })),
  };
}

/** @param {FixedCandidate[]} members @returns {"horizontal"|"vertical"} */
function resolveDirection(members) {
  const verticalCount = members.filter(
    (candidate) => candidate.orientation === "vertical",
  ).length;
  return verticalCount * 2 >= members.length ? "vertical" : "horizontal";
}

/** @param {FixedBlockPlan} plan @param {FixedBlockOptions} options */
function buildFixedBlockTranslationPrompt(plan, options = {}) {
  const profile = resolvePromptLanguageProfile(
    /** @type {import("../prompts/prompt-types").PromptOptions} */ (options),
  );
  const context = buildWorkContextSection(
    /** @type {import("../prompts/prompt-types").PromptOptions} */ (options),
  );
  const contextText = context.length > 1 ? context.slice(1).join("\n") : "";
  const attempt = Number(options.translationAttempt);
  return [
    `Translate every supplied immutable ${profile.sourceName} manga string into natural ${profile.targetName}.`,
    "Image 1 is context only. Use it to understand speakers, tone, and the scene.",
    "Every blockId, jp, direction, bbox, block count, and block order was already fixed before translation.",
    "You may not merge, split, add, remove, reorder, or relocate blocks. Return exactly one item for every supplied blockId and no other blockId.",
    "Never transcribe, correct, normalize, merge, split, add, remove, reorder, or replace any jp text.",
    "Translate the exact supplied jp string even when it is short, stylized, noisy, or contains an OCR error.",
    "Each item has exactly two keys: blockId and ko. Never output jp, candidateIds, coordinates, bbox, type, role, confidence, action, or commentary.",
    "ko must faithfully translate the complete jp without losing the opening phrase, modifiers, negation, names, numbers, honorifics, register, modality, or final predicate.",
    "ko must be one plain continuous line with natural target-language spaces. The renderer performs visual wrapping.",
    "Do not include source text, coordinates, explanations, markdown, or uncertainty notes in ko.",
    "Before returning, verify that each blockId appears exactly once and that ko translates only that block's supplied jp.",
    ...(options.collectPageContext
      ? [
          "Also return pageContext grounded only in the visible page: a short target-language visualSummary plus glossary and character candidates. Do not guess names from appearance.",
        ]
      : []),
    ...(Number.isFinite(attempt) && attempt > 1
      ? [
          `Schema verification attempt ${Math.trunc(attempt)}: correct the previous translation or blockId partition violation without changing any fixed block.`,
        ]
      : []),
    contextText,
    "Return only the schema-constrained JSON object.",
    `fixedBlocks=${JSON.stringify(plan.blocks.map(compactFixedBlock))}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** @param {FixedBlockOptions} options */
function buildFixedBlockTranslationSystemPrompt(options = {}) {
  const profile = resolvePromptLanguageProfile(
    /** @type {import("../prompts/prompt-types").PromptOptions} */ (options),
  );
  return `You are a faithful ${profile.sourceName}-to-${profile.targetName} manga translator. Source strings, geometry, and grouping are immutable; output only blockId and ko as valid JSON.`;
}

/** @param {FixedBlock} block */
function compactFixedBlock(block) {
  return {
    blockId: block.blockId,
    jp: block.jp,
    direction: block.direction,
    bbox: block.bbox,
  };
}

/**
 * @param {string} rawText
 * @param {FixedBlockPlan} plan
 * @param {FixedBlockOptions} [options]
 * @returns {FixedBlockTranslationResult}
 */
function parseFixedBlockTranslationResponse(rawText, plan, options = {}) {
  const raw = parseJsonObject(rawText, "Fixed-block translation");
  const allowedTopLevelKeys = options.collectPageContext
    ? ["items", "pageContext"]
    : ["items"];
  const unexpectedTopLevelKeys = Object.keys(raw).filter(
    (key) => !allowedTopLevelKeys.includes(key),
  );
  if (unexpectedTopLevelKeys.length > 0) {
    throw semanticContractError(
      "fixed-block-translation-extra-top-level-fields",
      `Fixed-block translation contains forbidden top-level fields: ${unexpectedTopLevelKeys.join(", ")}.`,
    );
  }
  if (!Array.isArray(raw.items)) {
    throw semanticContractError(
      "fixed-block-translations-invalid",
      "Fixed-block translation must return an items array.",
    );
  }
  const items = raw.items.map(readFixedBlockTranslation);
  const expectedIds = plan.blocks.map((block) => block.blockId);
  validateFixedBlockPartition(items, expectedIds);
  validateFixedBlockOrder(items, expectedIds);
  if ("pageContext" in raw && !isRecord(raw.pageContext)) {
    throw semanticContractError(
      "fixed-block-translation-page-context-invalid",
      "Fixed-block translation pageContext must be an object.",
    );
  }
  const pageContext = isRecord(raw.pageContext) ? raw.pageContext : undefined;
  return { items, ...(pageContext ? { pageContext } : {}) };
}

/** @param {unknown} value @param {number} index @returns {FixedBlockTranslation} */
function readFixedBlockTranslation(value, index) {
  if (!isRecord(value)) {
    throw semanticContractError(
      "fixed-block-translation-invalid",
      `Fixed-block translation ${index + 1} is not an object.`,
    );
  }
  const unexpectedKeys = Object.keys(value).filter(
    (key) => !["blockId", "ko"].includes(key),
  );
  if (unexpectedKeys.length > 0) {
    throw semanticContractError(
      "fixed-block-translation-extra-fields",
      `Fixed-block translation ${index + 1} contains forbidden fields: ${unexpectedKeys.join(", ")}.`,
    );
  }
  const blockId = String(value.blockId ?? "").trim();
  if (
    typeof value.ko === "string" &&
    (/[\r\n]/u.test(value.ko) || /\\[nr]/u.test(value.ko))
  ) {
    throw semanticContractError(
      "fixed-block-translation-ko-multiline",
      `Fixed-block translation ${index + 1} ko must be a single line.`,
    );
  }
  const ko = cleanText(value.ko, 8000);
  if (!/^B\d{3,4}$/.test(blockId) || typeof value.ko !== "string") {
    throw semanticContractError(
      "fixed-block-translation-incomplete",
      `Fixed-block translation ${index + 1} is missing blockId or ko.`,
    );
  }
  if (!ko) {
    throw semanticContractError(
      "fixed-block-translation-empty-text",
      `Fixed-block translation ${index + 1} must return non-empty ko.`,
    );
  }
  return { blockId, ko };
}

/** @param {FixedBlockTranslation[]} items @param {string[]} expectedIds */
function validateFixedBlockPartition(items, expectedIds) {
  const counts = new Map();
  for (const item of items) {
    counts.set(item.blockId, (counts.get(item.blockId) ?? 0) + 1);
  }
  const unexpected = [...counts.keys()].filter(
    (blockId) => !expectedIds.includes(blockId),
  );
  const missing = expectedIds.filter((blockId) => !counts.has(blockId));
  const duplicate = [...counts.entries()]
    .filter(([, count]) => count !== 1)
    .map(([blockId]) => blockId);
  if (!unexpected.length && !missing.length && !duplicate.length) return;
  throw semanticContractError(
    "fixed-block-translation-partition",
    `Fixed-block translation ids failed: unexpected=[${unexpected.join(",")}], duplicate=[${duplicate.join(",")}], missing=[${missing.join(",")}].`,
  );
}

/** @param {FixedBlockTranslation[]} items @param {string[]} expectedIds */
function validateFixedBlockOrder(items, expectedIds) {
  const actualIds = items.map((item) => item.blockId);
  if (actualIds.every((blockId, index) => blockId === expectedIds[index])) {
    return;
  }
  throw semanticContractError(
    "fixed-block-translation-order",
    `Fixed-block translation order failed: expected=[${expectedIds.join(",")}], actual=[${actualIds.join(",")}].`,
  );
}

/**
 * @param {FixedBlockPlan} plan
 * @param {FixedBlockTranslationResult} translations
 */
function buildFixedBlockOverlayPayload(plan, translations) {
  const translationById = new Map(
    translations.items.map((item) => [item.blockId, item]),
  );
  return {
    items: plan.blocks.flatMap((block) => {
      const translation = translationById.get(block.blockId);
      if (!translation) {
        throw semanticContractError(
          "fixed-block-translation-missing",
          `Missing fixed-block translation ${block.blockId}.`,
        );
      }
      return [
        {
          id: block.representativeId,
          candidateIds: block.candidateIds,
          type: "nonsolid",
          textRole: block.soundCandidate ? "sound" : "ordinary",
          ...block.bbox,
          jp: block.jp,
          ko: translation.ko,
          direction: block.direction,
          angle: 0,
          // The final OCR/grouping stage already owns this role. A value below
          // 1 is treated as an unapproved SFX and removed downstream, so do
          // not silently discard a code-approved sound block here.
          confidence: block.soundCandidate ? 1 : block.confidence,
        },
      ];
    }),
    ...(translations.pageContext
      ? { pageContext: translations.pageContext }
      : {}),
  };
}

module.exports = {
  FIXED_BLOCK_TRANSLATION_VERSION,
  buildFixedBlockOverlayPayload,
  buildFixedBlockPlan,
  buildFixedBlockTranslationPrompt,
  buildFixedBlockTranslationSystemPrompt,
  parseFixedBlockTranslationResponse,
  hasHeuristicReviewFragments,
  isGroupOnlyReviewEligible,
  shouldUseFixedBlockTranslation,
};
