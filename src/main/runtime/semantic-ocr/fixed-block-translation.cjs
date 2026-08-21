// @ts-check

/**
 * Final translation contract for the common semantic OCR path.
 *
 * OCR and the group-only crop review already own candidate membership and geometry.
 * This module gives the translator only opaque block ids and accepts only
 * role/translation text back. The model cannot recreate coordinates, candidate
 * ids, or groups.
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
  isRecord,
  positiveInteger,
  semanticContractError,
} = require("./values.cjs");
const {
  isRejectedLowConfidenceNoiseGroup,
  resolveFixedBlockConfidence,
} = require("./fixed-block-quality.cjs");
const {
  mergeFixedBlockTranslationResults,
  parseFixedBlockTranslationDraft,
  parseFixedBlockTranslationPartialResponse,
  parseFixedBlockTranslationResponse,
} = require("./fixed-block-response.cjs");

const FIXED_BLOCK_TRANSLATION_VERSION = 6;

/**
 * @typedef {{id:number;bbox:[number,number,number,number];text:string;score:number|null;orientation:"horizontal"|"vertical";soundCandidate:boolean}} FixedCandidate
 * @typedef {{blockId:string;representativeId:number;candidateIds:number[];directionVoterCandidateIds:number[];jp:string;direction:"horizontal"|"vertical";bbox:{x1:number;y1:number;x2:number;y2:number};confidence:number;soundCandidate:boolean;fragments:Array<{candidateId:number;text:string;score:number|null;bbox:[number,number,number,number]}>}} FixedBlock
 * @typedef {{version:6;blocks:FixedBlock[]}} FixedBlockPlan
 * @typedef {{blockId:string;ko:string;textRole?:"ordinary"|"sound";layoutIntent?:"horizontal"|"vertical";fontRole?:string;fontRoleConfidence?:number;visualClusterId?:string}} FixedBlockTranslation
 * @typedef {{items:FixedBlockTranslation[];pageContext?:Record<string,unknown>}} FixedBlockTranslationResult
 * @typedef {{sourceLanguage?:unknown;targetLanguage?:unknown;modelProvider?:unknown;regionCropMode?:unknown;keepBlocksMode?:unknown;promptOverrideText?:unknown;translationAttempt?:unknown;collectPageContext?:unknown;autoFontMatching?:unknown;ocrBboxHints?:unknown;validatedGroupOnlyReview?:unknown;[key:string]:unknown}} FixedBlockOptions
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
  const hintById = new Map(
    hints.flatMap((hint) => {
      const id = positiveInteger(hint?.id);
      return id ? [[id, hint]] : [];
    }),
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

  const acceptedMemberGroups = memberGroups.filter(
    (members) => !isRejectedLowConfidenceNoiseGroup(members, hintById, options),
  );
  return {
    version: FIXED_BLOCK_TRANSLATION_VERSION,
    blocks: acceptedMemberGroups.map((members, index) =>
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
    directionVoterCandidateIds: lexicalMembers.map((candidate) => candidate.id),
    jp: lexicalMembers
      .map(
        (candidate) =>
          sourceTextById.get(candidate.id) ?? String(candidate.text ?? ""),
      )
      .join(""),
    direction: resolveDirection(lexicalMembers),
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
    // A split SFX may contain several Paddle candidates. Keep it on the sound
    // path only when every member carries an explicit SFX classification;
    // mixed dialogue/SFX groups stay ordinary.
    soundCandidate:
      members.length > 0 &&
      members.every((candidate) => candidate.soundCandidate === true),
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
    "Image 1 is visual evidence. Use each bbox and the visible lettering/container to classify the text role as well as understand speakers, tone, and the scene.",
    "Every blockId, jp, direction, bbox, block count, and block order was already fixed before translation.",
    "You may not merge, split, add, remove, reorder, or relocate blocks. Return exactly one item for every supplied blockId and no other blockId.",
    "Never transcribe, correct, normalize, merge, split, add, remove, reorder, or replace any jp text.",
    "Translate the exact supplied jp string even when it is short, stylized, noisy, or contains an OCR error.",
    options.autoFontMatching
      ? "Each item requires blockId, textRole, layoutIntent, fontRole, fontRoleConfidence, and ko, and may additionally include visualClusterId. Never output jp, candidateIds, coordinates, bbox, type, confidence, action, or commentary."
      : 'Each item has exactly four keys: blockId, textRole, layoutIntent, and ko. textRole must be exactly "ordinary" or "sound". Never output jp, candidateIds, coordinates, bbox, type, confidence, action, or commentary.',
    'Use textRole "ordinary" for speech balloons, narration, captions, interface labels, titles, signs, notes, and readable dialogue even when the string is very short.',
    'Use textRole "sound" only for standalone printed sound effects, action noises, and stylized reaction lettering that belongs to the depicted scene rather than a speaker or label.',
    'Judge textRole from the original page image, bbox, lettering, and scene context. Do not classify by string length alone; when genuinely ambiguous, use "ordinary".',
    options.autoFontMatching
      ? 'layoutIntent must be exactly "auto", "horizontal", or "vertical" and is only a render advisory; it never changes source direction, bbox, grouping, or inpainting geometry.'
      : 'layoutIntent must be exactly "auto" or "horizontal". Never return "vertical" because this response has no current visual-role confidence evidence. It never changes source direction, bbox, grouping, or inpainting geometry.',
    'Use layoutIntent "horizontal" by default. Korean ordinary speech balloons, dialogue, thought, signs, labels, titles, and normal captions should remain horizontal even when the Japanese source is vertical. Do not use "auto" merely because the source is vertical.',
    ...(options.autoFontMatching
      ? [
          'Use layoutIntent "vertical" extremely sparingly: only for a genuinely long ordinary explanatory caption or narration column that is visibly very tall, very narrow, outside speech balloons, placed along the outer edge of the manga page, and classified in this same response as fontRole "narration" with finite fontRoleConfidence >= 0.82. Never use it for sound effects or text inside a balloon.',
        ]
      : []),
    'Use layoutIntent "auto" only when the image provides no useful direction evidence and the application should preserve its existing choice; do not prefer it over the horizontal default. The application will reject unsafe vertical advisories.',
    ...buildFixedBlockFontRoleLines(options),
    'For textRole "sound", translate as compact natural effect lettering instead of an explanatory sentence.',
    "ko must faithfully translate the complete jp without losing the opening phrase, modifiers, negation, names, numbers, honorifics, register, modality, or final predicate.",
    "ko must be one plain continuous line with natural target-language spaces. The renderer performs visual wrapping.",
    `Every ko value must be written only in ${profile.targetName}; never copy untranslated ${profile.sourceName} script from jp.`,
    ...(profile.isDefaultJapaneseToKorean
      ? [
          "For Korean output, Japanese kana, kanji, iteration marks, and Japanese prolonged-sound marks are forbidden. Translate or transliterate them into natural Hangul.",
        ]
      : []),
    "Do not include source text, coordinates, explanations, markdown, or uncertainty notes in ko.",
    "Before returning, verify that each blockId appears exactly once and that ko translates only that block's supplied jp.",
    ...(options.collectPageContext
      ? [
          "Also return pageContext grounded only in the visible page: a short target-language visualSummary plus glossary and character candidates. Do not guess names from appearance.",
        ]
      : []),
    ...(Number.isFinite(attempt) && attempt > 1
      ? [
          `Schema verification attempt ${Math.trunc(attempt)}: correct the previous translation, layout advisory, target-language, or blockId partition violation without changing any fixed block.`,
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
  const outputKeys = options.autoFontMatching
    ? "blockId, textRole, layoutIntent, fontRole, fontRoleConfidence, ko, and optional visualClusterId"
    : "blockId, textRole, layoutIntent, and ko";
  return `You are a faithful ${profile.sourceName}-to-${profile.targetName} manga translator and visual text-role classifier. Source strings, geometry, and grouping are immutable; classify each visible fixed block, write ko only in ${profile.targetName} without untranslated source script, and output only ${outputKeys} as valid JSON.`;
}

/** @param {FixedBlockOptions} options */
function buildFixedBlockFontRoleLines(options) {
  if (!options.autoFontMatching) return [];
  return [
    "fontRole must be exactly one of dialogue, narration, thought, whisper, aside_balloon_edge, emphasis_dialogue, shout, sfx_impact, sfx_motion, sfx_ambient, sfx_emotion, sfx_comic, sign_ui_title, other, unknown_needs_review.",
    "Classify fontRole from visible lettering and container only, never from the work title, genre stereotype, translated wording, or string length.",
    "Use dialogue for normal balloons; narration for caption/free narration; thought for internal monologue; aside_balloon_edge for detached small balloon-adjacent lettering; emphasis_dialogue or shout only when visually clear.",
    "Separate SFX into impact, motion, ambient, emotion, or comic by the depicted sound and lettering. Use sign_ui_title for signs, interface labels, titles, and display cards.",
    'fontRole values beginning with "sfx_" require textRole "sound"; every other concrete fontRole requires textRole "ordinary".',
    'layoutIntent "vertical" is valid only when this same response has fontRole exactly "narration" and finite fontRoleConfidence >= 0.82. Every other role or confidence must use layoutIntent "horizontal" or "auto", regardless of Japanese source orientation.',
    "fontRoleConfidence is confidence in the fine-grained visual role only. Use below 0.82 when uncertain and unknown_needs_review when the role cannot be decided safely.",
    "visualClusterId is optional. Use one short ID only when two or more separate non-body accent blocks visibly share the same repeated lettering treatment, and reuse that exact ID on those members.",
    "Omit visualClusterId for dialogue, narration, thought, and whenever the visual grouping is uncertain.",
  ];
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
      const modelClassifiedSound =
        translation.textRole === "sound" && block.confidence >= 0.58;
      const soundCandidate = block.soundCandidate || modelClassifiedSound;
      const layoutIntent = normalizeFixedBlockLayoutIntent(
        translation.layoutIntent,
      );
      return [
        {
          id: block.representativeId,
          candidateIds: block.candidateIds,
          type: "nonsolid",
          textRole: soundCandidate ? "sound" : "ordinary",
          ...(!soundCandidate && layoutIntent !== "auto"
            ? { layoutIntent }
            : {}),
          ...(translation.fontRole
            ? {
                fontRole: translation.fontRole,
                fontRoleConfidence: translation.fontRoleConfidence ?? 0,
              }
            : {}),
          ...(translation.visualClusterId
            ? { visualClusterId: translation.visualClusterId }
            : {}),
          ...block.bbox,
          jp: block.jp,
          ko: translation.ko,
          direction: block.direction,
          angle: 0,
          // A vision-classified effect still needs usable OCR evidence. Once
          // both agree, approve it for the existing exact-1 SFX gate so role
          // classification cannot make previously accepted text disappear.
          confidence: resolveFixedBlockConfidence(
            modelClassifiedSound
              ? {
                  ...block,
                  soundCandidate: true,
                  confidence: Math.max(block.confidence, 0.82),
                }
              : { ...block, soundCandidate },
          ),
        },
      ];
    }),
    ...(translations.pageContext
      ? { pageContext: translations.pageContext }
      : {}),
  };
}

/** @param {unknown} value @returns {"auto"|"horizontal"|"vertical"} */
function normalizeFixedBlockLayoutIntent(value) {
  return value === "horizontal" || value === "vertical" ? value : "auto";
}

module.exports = {
  FIXED_BLOCK_TRANSLATION_VERSION,
  buildFixedBlockOverlayPayload,
  buildFixedBlockPlan,
  buildFixedBlockTranslationPrompt,
  buildFixedBlockTranslationSystemPrompt,
  mergeFixedBlockTranslationResults,
  parseFixedBlockTranslationDraft,
  parseFixedBlockTranslationPartialResponse,
  parseFixedBlockTranslationResponse,
  hasHeuristicReviewFragments,
  isGroupOnlyReviewEligible,
  shouldUseFixedBlockTranslation,
};
