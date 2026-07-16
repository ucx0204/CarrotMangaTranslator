// @ts-check
/** @typedef {import("./prompt-types").PromptOptions} PromptOptions */
/** @typedef {import("./prompt-types").PromptSection} PromptSection */

/**
 * @param {PromptOptions} [options]
 * @returns {PromptSection}
 */
function buildPageContextSection(options = {}) {
  if (!options.collectPageContext || options.regionCropMode) {
    return [];
  }
  return [
    "Page context trailer",
    "After all translation records, append exactly one <page-context>...</page-context> section. This trailer is machine-readable data, not commentary.",
    "Inside the tags return one valid JSON object with exactly these top-level keys: visualSummary, glossary, characters.",
    "visualSummary must summarize the visible scene, actions, and dialogue meaning in the target language in one or two short sentences. Do not assert uncertain identities, relationships, motives, or off-panel events.",
    "glossary contains only concrete names or recurring terms supported by visible source text, OCR candidates, or the translation records from this page. Never repeat a supplied glossary entry or alias.",
    "Each glossary item uses source, target, category, aliases, and note. category is one of character, alias, place, term, honorific, other.",
    "characters contains only people whose name or identity wording is supported on this page. Never guess a name from appearance alone and never repeat a supplied character name or alias.",
    "Each character item uses displayName, sourceNames, targetName, aliases, speechStyle, customSpeechStyle, and note. speechStyle is one of neutral, polite, casual, rough, childish, elderly, formal, custom.",
    "Use empty arrays when there are no grounded glossary or character candidates.",
    "When the page has no readable source text, output no translation records and still append the trailer with a visualSummary and empty candidate arrays.",
    "Trailer shape:",
    "<page-context>",
    '{"visualSummary":"one or two short target-language sentences","glossary":[],"characters":[]}',
    "</page-context>",
  ];
}

module.exports = { buildPageContextSection };
