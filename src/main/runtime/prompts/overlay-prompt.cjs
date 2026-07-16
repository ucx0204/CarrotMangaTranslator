// @ts-check
/** @typedef {import("./prompt-types").PromptOptions} PromptOptions */
/** @typedef {import("./prompt-types").ImageVariant} ImageVariant */
/** @typedef {import("./prompt-types").PromptSection} PromptSection */

const {
  resolvePromptLanguageProfile,
} = require("../simple-page-language-profile.cjs");
const { buildCoordinateCalibrationSection } = require("./coordinates.cjs");
const { localizePromptTextForProfile } = require("./localization.cjs");
const {
  SMALL_GEMMA_DUPLICATE_OUTPUT_LINES,
  SMALL_GEMMA_DUPLICATE_SEGMENTATION_LINES,
} = require("./model-profile.cjs");
const { buildOcrBboxHintSection } = require("./ocr-bbox-section.cjs");
const { buildPreviousPassSection } = require("./previous-pass.cjs");
const { buildRegionOcrReadingHintSection } = require("./region-ocr-hints.cjs");
const {
  buildRegionOutputSection,
  buildRegionTaskSection,
  buildStrictRefineSection,
  buildTaskSection,
} = require("./task-sections.cjs");
const { buildWorkContextSection } = require("./work-context.cjs");
const { buildPageContextSection } = require("./page-context.cjs");

/**
 * @param {PromptSection[]} sections
 * @param {string} title
 * @param {string} anchorLine
 * @param {string[]} lines
 * @param {number} offset
 * @returns {void}
 */
function insertSectionLines(sections, title, anchorLine, lines, offset) {
  const section = sections.find((candidate) => candidate[0] === title);
  if (!section) {
    return;
  }
  const anchorIndex = section.indexOf(anchorLine);
  const insertionIndex =
    anchorIndex === -1 ? section.length : anchorIndex + offset;
  section.splice(insertionIndex, 0, ...lines);
}

/** @param {PromptSection[]} sections @returns {void} */
function applyModelSpecificPromptProfile(sections) {
  insertSectionLines(
    sections,
    "Output",
    "Do not copy placeholder text. Estimate every value from the actual glyphs in Image 1.",
    SMALL_GEMMA_DUPLICATE_OUTPUT_LINES,
    0,
  );
  insertSectionLines(
    sections,
    "Segmentation",
    "Inside one speech bubble, group all Japanese glyph lines from that same bubble into one item.",
    SMALL_GEMMA_DUPLICATE_SEGMENTATION_LINES,
    1,
  );
}

/** @param {PromptSection[]} sections @param {PromptOptions} options @returns {void} */
function applyPageContextOutputException(sections, options) {
  if (!options.collectPageContext) return;
  const output = sections.find((section) => section[0] === "Output");
  if (!output) return;
  const original =
    "Return plain text records only. Do not output JSON, markdown, bullets, commentary, or code fences.";
  const index = output.indexOf(original);
  if (index === -1) return;
  output[index] =
    "Return translation records as plain text only. Do not output JSON, markdown, bullets, commentary, or code fences inside the translation records; the only JSON exception is the required <page-context> trailer described below.";
}

/**
 * @param {PromptSection[]} sections
 * @param {PromptSection} section
 * @param {string[]} anchorTitles
 * @returns {void}
 */
function insertOptionalSection(sections, section, anchorTitles) {
  if (section.length <= 1) {
    return;
  }
  const anchorIndex = anchorTitles.reduce(
    (latest, title) =>
      Math.max(
        latest,
        sections.findIndex((item) => item[0] === title),
      ),
    -1,
  );
  sections.splice(anchorIndex === -1 ? 2 : anchorIndex + 1, 0, section);
}

/**
 * @param {PromptSection[]} baseSections
 * @param {PromptOptions} [options]
 * @param {ImageVariant[]} [imageVariants]
 * @returns {string}
 */
function buildOverlayPrompt(baseSections, options = {}, imageVariants = []) {
  if (options.regionCropMode) {
    return buildRegionOverlayPrompt(options, imageVariants);
  }

  const sections = baseSections.map(([title, ...lines]) => [title, ...lines]);
  sections[0] = buildTaskSection(options, imageVariants);
  applyModelSpecificPromptProfile(sections);
  applyPageContextOutputException(sections, options);
  insertOptionalSection(
    sections,
    buildCoordinateCalibrationSection(options, imageVariants),
    [],
  );
  insertOptionalSection(sections, buildStrictRefineSection(options), [
    "Coordinate calibration",
  ]);
  insertOptionalSection(sections, buildWorkContextSection(options), [
    "Coordinate calibration",
    "Strict refinement mode",
  ]);
  insertOptionalSection(
    sections,
    buildPreviousPassSection(options, imageVariants),
    [
      "Coordinate calibration",
      "Strict refinement mode",
      "Work glossary and story memory",
    ],
  );
  insertOptionalSection(
    sections,
    buildOcrBboxHintSection(options, imageVariants),
    [
      "Coordinate calibration",
      "Strict refinement mode",
      "Work glossary and story memory",
      "Previous pass blocks",
    ],
  );
  const pageContextSection = buildPageContextSection(options);
  if (pageContextSection.length > 1) {
    sections.push(pageContextSection);
  }

  return localizeSections(sections, options);
}

/**
 * @param {PromptOptions} [options]
 * @param {ImageVariant[]} [imageVariants]
 * @returns {string}
 */
function buildRegionOverlayPrompt(options = {}, imageVariants = []) {
  const languageProfile = resolvePromptLanguageProfile(options);
  const sections = [
    buildRegionTaskSection(imageVariants),
    buildCoordinateCalibrationSection(options, imageVariants),
    buildRegionOutputSection(languageProfile),
    buildWorkContextSection(options),
    buildRegionOcrReadingHintSection(options, imageVariants),
  ].filter((section) => section.length > 1);
  return localizePromptTextForProfile(
    formatSections(sections),
    languageProfile,
  );
}

/** @param {PromptSection[]} sections @returns {string} */
function formatSections(sections) {
  return sections
    .map(([title, ...lines]) => [`# ${title}`, ...lines].join("\n"))
    .join("\n\n");
}

/**
 * @param {PromptSection[]} sections
 * @param {PromptOptions} options
 * @returns {string}
 */
function localizeSections(sections, options) {
  return localizePromptTextForProfile(
    formatSections(sections),
    resolvePromptLanguageProfile(options),
  );
}

module.exports = { buildOverlayPrompt };
