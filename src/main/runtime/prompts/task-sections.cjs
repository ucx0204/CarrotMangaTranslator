// @ts-check
/** @typedef {import("./prompt-types").PromptOptions} PromptOptions */
/** @typedef {import("./prompt-types").ImageVariant} ImageVariant */
/** @typedef {import("./prompt-types").PromptSection} PromptSection */
/** @typedef {import("../simple-page-language-profile.cjs").PromptLanguageProfile} PromptLanguageProfile */

/**
 * @param {PromptOptions} [options]
 * @param {ImageVariant[]} [imageVariants]
 * @returns {PromptSection}
 */
function buildTaskSection(options = {}, imageVariants = []) {
  const hasAssistImages = imageVariants.length > 1;
  const regionCropMode = Boolean(options.regionCropMode);
  const hasRegionContextImage =
    regionCropMode &&
    imageVariants.some((variant) => variant.role === "full-page-context");
  const strictRefineMode = Boolean(options.strictRefineMode);
  return [
    "Task",
    describeTaskInput(hasRegionContextImage, hasAssistImages, regionCropMode),
    describeCoordinateAuthority(
      hasRegionContextImage,
      hasAssistImages,
      regionCropMode,
    ),
    "Detect every visible Japanese text group and translate it into concise Korean.",
    ...buildTaskRefinementLines(
      strictRefineMode,
      Boolean(options.keepBlocksMode),
    ),
    regionCropMode
      ? "Scan the entire selected crop before writing records; do not stop after the first obvious text."
      : "Scan the entire page before writing records; do not stop after the first obvious text.",
    "First identify the exact Japanese glyph strokes for each item, then write the record. Do not estimate from the speech bubble or panel shape.",
    "Before reading dialogue text, segment the visible speech balloons themselves. Each distinct balloon lobe and each separated dialogue text cluster becomes a separate dialogue record.",
    "Only output real Japanese text. Do not output decorative line art, background marks, panel ornaments, texture, or unreadable marks as text.",
  ];
}

/**
 * @param {boolean} hasRegionContextImage
 * @param {boolean} hasAssistImages
 * @param {boolean} regionCropMode
 * @returns {string}
 */
function describeTaskInput(
  hasRegionContextImage,
  hasAssistImages,
  regionCropMode,
) {
  if (hasRegionContextImage) {
    return "You are given Image 1, a user-selected crop from a Japanese manga page, plus a full-page context image.";
  }
  if (hasAssistImages) {
    return "You are given the same Japanese manga page in multiple full-page renderings.";
  }
  return regionCropMode
    ? "You are given one user-selected crop from a Japanese manga page."
    : "You are given one full-page Japanese manga image.";
}

/**
 * @param {boolean} hasRegionContextImage
 * @param {boolean} hasAssistImages
 * @param {boolean} regionCropMode
 * @returns {string}
 */
function describeCoordinateAuthority(
  hasRegionContextImage,
  hasAssistImages,
  regionCropMode,
) {
  if (hasRegionContextImage) {
    return "Image 1 is the coordinate-authority selected crop. The full-page context image is only for understanding the same page, never for output coordinates or extra records.";
  }
  if (hasAssistImages) {
    return "Image 1 is the coordinate-authority full page. Assist images are only for reading the same page.";
  }
  return regionCropMode
    ? "Image 1 is the coordinate-authority selected crop."
    : "Image 1 is the coordinate-authority full page.";
}

/**
 * @param {boolean} strictRefineMode
 * @param {boolean} keepBlocksMode
 * @returns {string[]}
 */
function buildTaskRefinementLines(strictRefineMode, keepBlocksMode) {
  if (!strictRefineMode) {
    return [];
  }
  if (keepBlocksMode) {
    return [
      "This is a fixed-blocks refinement. The OCR candidates are user-defined block regions; translate the Japanese visible inside each candidate rectangle and output one record per candidate id.",
      "Do not merge, split, move, or resize candidate regions, and do not add records outside them.",
    ];
  }
  return [
    "This is a strict second-pass refinement. Treat OCR candidates as the main geometry anchors, and use previous pass blocks only as weak review hints, never as trusted source text.",
    "When OCR split one visual text container into adjacent line/column candidates, collapse those fragments into one corrected ordinary record instead of preserving the bad split.",
    "After collapsing split candidates, re-translate the combined Japanese from Image 1 and the corrected group text; do not stitch together the old Korean fragments.",
    "Do not re-detect the page from scratch in a way that duplicates existing OCR candidates or previous physical text areas.",
  ];
}

/**
 * @param {PromptOptions} [options]
 * @returns {PromptSection}
 */
function buildStrictRefineSection(options = {}) {
  if (!options.strictRefineMode) {
    return [];
  }

  if (options.keepBlocksMode) {
    return [
      "Strict refinement mode",
      "Fixed-blocks refinement: every OCR candidate below is a user-defined block slot, and each previous pass block lists its matching candidateId.",
      "Output exactly one record per candidate id whose rectangle contains readable Japanese, reusing that candidate id and the exact rectangle numbers shown for it.",
      "Never merge two candidates into one record, even when the sentence continues across them, they touch, or they sit inside one speech bubble. Each candidate keeps its own record and id.",
      "Never output a new id. If Japanese text is visible outside every candidate rectangle, ignore it completely.",
      "Previous pass blocks are weak wording hints only. Re-read the visible Japanese inside each candidate rectangle from Image 1 and correct OCR, ruby, and previous-translation mistakes.",
      "Decide textRole from the visible glyphs and container: text inside a speech bubble, caption, note, or sign is ordinary even when short or vertical.",
      "Never invent onomatopoeia or mood words. If a candidate rectangle contains no readable Japanese glyphs, omit that id instead of guessing from the artwork, darkness, or scene mood.",
      "When a candidate includes an ocrText hint, treat it as the primary reading evidence: verify it against Image 1 and translate that text.",
      "For real sound-effect lettering, use confidence 1.00 only when the reading and Korean sound choice are certain; otherwise output confidence below 1.00 so the app drops it.",
      "Story memory can contain earlier machine-translation mistakes. Use it only for continuity and pronouns; never copy a story-memory term or wording that conflicts with Image 1, glossary entries, or the visible source text.",
    ];
  }

  return [
    "Strict refinement mode",
    "This pass improves an existing Korean overlay result. It should be conservative for ids, geometry, and duplicate avoidance, but assertive about correcting OCR and previous-pass text mistakes.",
    "Priority order: 1. Image 1 visible Japanese glyphs, 2. OCR candidate bbox/id/group, 3. style-guide glossary and character memory, 4. story memory, 5. previous pass jp/ko.",
    "Existing OCR candidate ids are the main anchors. For the same physical Japanese text area, keep the same candidate id whenever an OCR candidate exists.",
    "If two or more adjacent OCR candidates are clearly columns/lines/fragments inside one speech bubble, caption, note, or sign, output one merged ordinary record using the first candidate id in Japanese reading order. The merged bbox should cover the union of the visible glyph ink from those candidates, and the swallowed candidate ids should not be output separately.",
    "For same-container merged candidates, previous-pass blocks for the individual candidate ids are usually split artifacts. Recompute one jp and one ko from the grouped visible text instead of preserving the old separate translations.",
    "Do not merge separate speech bubbles, stacked balloon lobes, separate caption plates, UI/menu/list rows, or unrelated nearby text just because the sentence continues.",
    "Previous pass blocks are weak review hints only. Their jp/sourceText can also be OCR or model output, not visible Japanese source text, and must never create a record by themselves.",
    "Use previous Korean wording only when it naturally matches the same visible Japanese glyph area. Correct it when Image 1, OCR, glossary, story memory, or SFX context proves a better result.",
    "Do not import Korean meanings for words absent from the corrected jp just because an earlier pass suggested them.",
    "Story memory can contain earlier machine-translation mistakes. Use it only for continuity and pronouns; never copy a story-memory term or wording that conflicts with Image 1, glossary entries, or the visible source text.",
    "For previous-pass SFX, do not preserve Korean wording for stability. Re-read the source glyphs from Image 1. If the SFX reading or Korean sound choice is not clearly right, output confidence below 1.00 or omit it.",
    "Never add a new record to correct, restate, enlarge, re-read, or provide an alternate translation for an existing OCR candidate or previous physical text area. Correct the existing record instead.",
    "New ids are exceptional. A new id is valid only when a complete Japanese glyph cluster is clearly visible outside every OCR candidate box and is not a duplicate of any previous block.",
    "A new SFX record is valid only when the complete source glyph group is clearly Japanese kana/kanji, fully visible, outside OCR candidates, and output as textRole sound. Dots, dashes, Latin letters, digits, panel lines, and decorative strokes are invalid.",
  ];
}

/**
 * @param {ImageVariant[]} [imageVariants]
 * @returns {PromptSection}
 */
function buildRegionTaskSection(imageVariants = []) {
  const hasFullPageContext = imageVariants.some(
    (variant) => variant.role === "full-page-context",
  );
  return [
    "Task",
    hasFullPageContext
      ? "You are given Image 1, a user-selected crop from a Japanese manga page, plus Image 2, the original full page for context."
      : "You are given Image 1, a user-selected crop from a Japanese manga page.",
    "Image 1 is the coordinate-authority selected crop.",
    ...(hasFullPageContext
      ? [
          "Use Image 2 only to understand the speaker, surrounding scene, nearby dialogue flow, and whether Image 1 is part of a larger balloon.",
        ]
      : []),
    "Translate the readable Japanese visible inside Image 1 into concise natural Korean.",
    "Read the whole selected crop before deciding the final Japanese source string.",
    "For one speech bubble, caption plate, note, sign, label, or continuous SFX shape, gather its visible columns and lines in natural Japanese reading order.",
    "The bbox coordinates belong to Image 1.",
  ];
}

/**
 * @param {PromptLanguageProfile} profile
 * @returns {PromptSection}
 */
function buildRegionOutputSection(profile) {
  // The generic profile keeps the JSON example ASCII-only so the language
  // localization line filter can never break the example structure.
  const sourceExample = profile.isDefaultJapaneseToKorean
    ? "見える日本語"
    : `visible ${profile.sourceName} text`;
  const targetExample = profile.isDefaultJapaneseToKorean
    ? "자연스러운 한국어"
    : `natural ${profile.targetName} translation`;
  return [
    "Output",
    "Return exactly one JSON object with one key named item.",
    "When readable Japanese exists, use this shape:",
    "{",
    '  "item": {',
    '    "type": "nonsolid",',
    '    "textRole": "ordinary",',
    '    "x1": 10,',
    '    "y1": 20,',
    '    "x2": 110,',
    '    "y2": 160,',
    '    "direction": "vertical",',
    '    "angle": 0,',
    '    "fontSize": 24,',
    '    "confidence": 0.95,',
    `    "${profile.sourceKey}": "${sourceExample}",`,
    `    "${profile.targetKey}": "${targetExample}"`,
    "  }",
    "}",
    "When no readable Japanese exists, use this shape:",
    "{",
    '  "item": null',
    "}",
    "Use type nonsolid. Use textRole ordinary for speech, captions, labels, signs, and notes; use textRole sound only for standalone printed SFX or reaction lettering.",
    "x1, y1, x2, y2 tightly cover the visible Japanese glyph ink and outline inside Image 1.",
    "jp contains the visible Japanese source from Image 1 in natural reading order. ko contains one coherent Korean translation.",
    "Use horizontal Korean for ordinary speech, captions, labels, signs, and notes.",
  ];
}

module.exports = {
  buildRegionOutputSection,
  buildRegionTaskSection,
  buildStrictRefineSection,
  buildTaskSection,
};
