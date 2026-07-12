// @ts-check
/** @typedef {import("./prompt-types").PromptOptions} PromptOptions */
/** @typedef {import("./prompt-types").PromptSection} PromptSection */
/** @typedef {import("./prompt-types").PromptGlossaryEntry} PromptGlossaryEntry */
/** @typedef {import("./prompt-types").PromptCharacterEntry} PromptCharacterEntry */

const {
  resolvePromptLanguageProfile,
} = require("../simple-page-language-profile.cjs");
const { sanitizePromptLine } = require("./common.cjs");

/**
 * @param {PromptOptions} [options]
 * @returns {PromptSection}
 */
function buildWorkContextSection(options = {}) {
  const context = options.workContext;
  if (!context || !context.styleGuide) {
    return [];
  }

  const guide = context.styleGuide;
  const regionCropMode = Boolean(options.regionCropMode);
  const targetIsKorean =
    resolvePromptLanguageProfile(options).targetBaseCode === "ko";
  const lines = buildWorkContextIntroduction(regionCropMode);
  appendGlossaryLines(
    lines,
    readEnabledGlossary(guide.glossary),
    targetIsKorean,
  );
  appendCharacterLines(
    lines,
    readEnabledCharacters(guide.characters),
    targetIsKorean,
  );
  appendStoryLines(lines, context.storyMemory?.pages, regionCropMode);
  lines.push(formatRules(guide.rules, targetIsKorean));
  return lines;
}

/** @param {boolean} regionCropMode @returns {PromptSection} */
function buildWorkContextIntroduction(regionCropMode) {
  return [
    "Work glossary and story memory",
    regionCropMode
      ? "Use these notes only as translation context for the visible Japanese inside Image 1."
      : "Do not output these notes as records.",
    "Glossary and character entries are stronger than story memory. Story memory may contain earlier OCR or translation mistakes, so use it only for context unless the visible source text supports it.",
  ];
}

/**
 * @param {PromptGlossaryEntry[] | undefined} glossary
 * @returns {PromptGlossaryEntry[]}
 */
function readEnabledGlossary(glossary) {
  return Array.isArray(glossary)
    ? glossary.filter((entry) => entry && entry.enabled !== false)
    : [];
}

/**
 * @param {PromptCharacterEntry[] | undefined} characters
 * @returns {PromptCharacterEntry[]}
 */
function readEnabledCharacters(characters) {
  return Array.isArray(characters)
    ? characters.filter((entry) => entry && entry.enabled !== false)
    : [];
}

/**
 * @param {PromptSection} lines
 * @param {PromptGlossaryEntry[]} glossary
 * @param {boolean} targetIsKorean
 * @returns {void}
 */
function appendGlossaryLines(lines, glossary, targetIsKorean) {
  if (glossary.length > 0) {
    lines.push(
      targetIsKorean
        ? "Use these glossary entries for consistency. If the source text matches an entry or alias, prefer the target Korean exactly unless Image 1 clearly proves a different meaning."
        : "Use glossary source terms and aliases for identity and meaning. Stored target values may come from an earlier target language: reuse one exactly only when it is already written in the requested target language; otherwise translate or localize it into the requested target language.",
      "When a glossary term is written as kanji with furigana/ruby, the kanji and ruby are one term. Translate that term once using the glossary target, and do not treat ruby as an extra name after particles like の.",
    );
    for (const entry of glossary.slice(0, 80)) {
      lines.push(formatGlossaryEntry(entry));
    }
  }
}

/**
 * @param {PromptSection} lines
 * @param {PromptCharacterEntry[]} characters
 * @param {boolean} targetIsKorean
 * @returns {void}
 */
function appendCharacterLines(lines, characters, targetIsKorean) {
  if (characters.length > 0) {
    lines.push(
      targetIsKorean
        ? "Character/name memory. Keep names and speech style consistent when translating dialogue."
        : "Character/name memory. Stored display and target names may come from an earlier target language; use them as identity hints and render names and dialogue in the requested target language.",
    );
    for (const character of characters.slice(0, 40)) {
      lines.push(formatCharacterEntry(character));
    }
  }
}

/**
 * @param {PromptSection} lines
 * @param {import("./prompt-types").PromptStoryPage[] | undefined} pages
 * @param {boolean} regionCropMode
 * @returns {void}
 */
function appendStoryLines(lines, pages, regionCropMode) {
  if (Array.isArray(pages) && pages.length > 0) {
    lines.push(
      regionCropMode
        ? "Recent story context from previous pages. Use it only to resolve pronouns, omitted subjects, relationships, tone, and continuity for Image 1."
        : "Recent story context from previous pages. Use it only to resolve pronouns, omitted subjects, relationships, tone, and continuity. Do not output these notes as records.",
    );
    for (const page of pages.slice(-6)) {
      lines.push(
        `- p${Number(page.pageIndex) + 1} ${sanitizePromptLine(page.pageName)}: ${sanitizePromptLine(page.summary || page.translatedDigest || "")}`,
      );
    }
  }
}

/**
 * @param {import("./prompt-types").PromptRules | undefined} rules
 * @param {boolean} targetIsKorean
 * @returns {string}
 */
function formatRules(rules = {}, targetIsKorean) {
  const defaultTone =
    !targetIsKorean &&
    (!rules.defaultTone || rules.defaultTone === "natural_korean")
      ? "natural_target"
      : rules.defaultTone || "natural_korean";
  return `Rules: honorifics=${rules.honorifics || "adapt"}, sfxMode=${rules.sfxMode || "translate"}, defaultTone=${defaultTone}.`;
}

/**
 * @param {PromptGlossaryEntry} entry
 * @returns {string}
 */
function formatGlossaryEntry(entry) {
  const aliases =
    Array.isArray(entry.aliases) && entry.aliases.length
      ? ` aliases=${entry.aliases.map((value) => sanitizePromptLine(value, 80)).join(", ")}`
      : "";
  const note = entry.note ? ` note=${sanitizePromptLine(entry.note, 160)}` : "";
  return `- [${entry.category || "term"}] ${sanitizePromptLine(entry.source, 80)} => ${sanitizePromptLine(entry.target, 80)}${aliases}${note}`;
}

/**
 * @param {PromptCharacterEntry} character
 * @returns {string}
 */
function formatCharacterEntry(character) {
  const sourceNames = Array.isArray(character.sourceNames)
    ? character.sourceNames.join(", ")
    : "";
  const style =
    character.speechStyle === "custom"
      ? character.customSpeechStyle || "custom"
      : character.speechStyle || "neutral";
  return `- ${sanitizePromptLine(character.displayName || character.targetName, 80)}: sourceNames=${sanitizePromptLine(sourceNames, 160)} targetName=${sanitizePromptLine(character.targetName, 80)} speechStyle=${sanitizePromptLine(style, 160)}`;
}

module.exports = { buildWorkContextSection };
