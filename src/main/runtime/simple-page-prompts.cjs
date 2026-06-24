// @ts-check
/**
 * @typedef {{ x?: unknown; y?: unknown; w?: unknown; h?: unknown }} PromptBbox
 * @typedef {{ previousId?: unknown; index?: unknown; candidateId?: unknown; bbox?: PromptBbox; textRole?: unknown; sourceText?: unknown; translatedText?: unknown; confidence?: unknown }} PreviousPromptBlock
 * @typedef {{ modelProvider?: string; modelRepo?: unknown; modelFile?: unknown; localModelPath?: unknown; regionCropMode?: unknown; strictRefineMode?: unknown; previousBlocksForPrompt?: PreviousPromptBlock[]; workContext?: PromptWorkContext | null; imageWidth?: unknown; imageHeight?: unknown; ocrBboxHints?: OcrHint[]; [key: string]: unknown }} PromptOptions
 * @typedef {{ role?: string; width?: unknown; height?: unknown; [key: string]: unknown }} ImageVariant
 * @typedef {string[]} PromptSection
 * @typedef {{ styleGuide?: PromptStyleGuide | null; storyMemory?: { pages?: PromptStoryPage[] } | null }} PromptWorkContext
 * @typedef {{ glossary?: PromptGlossaryEntry[]; characters?: PromptCharacterEntry[]; rules?: PromptRules }} PromptStyleGuide
 * @typedef {{ enabled?: boolean; aliases?: unknown[]; note?: unknown; category?: unknown; source?: unknown; target?: unknown }} PromptGlossaryEntry
 * @typedef {{ enabled?: boolean; sourceNames?: unknown[]; speechStyle?: unknown; customSpeechStyle?: unknown; displayName?: unknown; targetName?: unknown }} PromptCharacterEntry
 * @typedef {{ honorifics?: unknown; sfxMode?: unknown; defaultTone?: unknown }} PromptRules
 * @typedef {{ pageIndex?: unknown; pageName?: unknown; summary?: unknown; translatedDigest?: unknown }} PromptStoryPage
 * @typedef {{ id?: unknown; label?: unknown; x1?: unknown; y1?: unknown; x2?: unknown; y2?: unknown; score?: unknown; groupId?: unknown; orderInGroup?: unknown; rolePrior?: unknown; containerType?: unknown; [key: string]: unknown }} OcrHint
 * @typedef {{ groupId: string; rolePrior: string; containerType: string; hints: OcrHint[] }} OcrHintGroup
 * @typedef {{ x1: number; y1: number; x2: number; y2: number }} PromptBox
 * @typedef {{ space: "pixels" | "normalized_1000"; frame: { width: number; height: number } }} PromptCoordinateFrame
 */

/**
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {string}
 */
function truncateText(value, maxLength) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}... [truncated ${text.length - maxLength} chars]`;
}

/**
 * @param {PromptOptions} [options]
 * @returns {boolean}
 */
function isOpenAICodexProvider(options = {}) {
  return String(options.modelProvider ?? "").trim() === "openai-codex";
}

/**
 * @param {PromptOptions} [options]
 * @returns {boolean}
 */
function shouldUseSmallGemmaDuplicatePromptProfile(options = {}) {
  if (isOpenAICodexProvider(options)) {
    return false;
  }
  const modelText = [
    options.modelRepo,
    options.modelFile,
    options.localModelPath,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /(^|[^0-9])(12b|26b)([^0-9]|$)|26b-a4b/.test(modelText);
}

const SMALL_GEMMA_DUPLICATE_OUTPUT_LINES = [
  "One physical Japanese text area may appear only once in the output. Never output multiple records whose boxes sit on the same glyph cluster, same speech bubble text, same caption text, or same SFX group.",
  "If two possible records would occupy the same place or mostly cover the same visible glyphs, keep one record only. Put all readable source lines for that same area into that one jp field and one Korean translation.",
  "Never stack several records at the same x/y position to represent separate lines, columns, words, or fragments inside one visual text area.",
  "Never output a later correction record that repeats, contains, or is contained by the jp text of an earlier record from the same visual area. Correct the original record instead of adding another one.",
];

const SMALL_GEMMA_DUPLICATE_SEGMENTATION_LINES = [
  "Inside one speech bubble, caption box, note, sign, label, or one continuous SFX glyph group, do not create overlapping records for separate columns, lines, words, or fragments. Same physical place means one record.",
];

const SMALL_GEMMA_OCR_ANCHOR_LINES = [
  "OCR text hints may be wrong, incomplete, or split strangely, but treat the OCR candidate rectangles as your primary geometry anchors unless Image 1 clearly proves otherwise.",
  "Compared with pure visual guessing, trust the OCR candidate placement and grouping more strongly: about 70% OCR geometry anchor, 30% visual correction from Image 1.",
  "Use the OCR text hint and candidate rectangle together to keep each translated record attached to the correct candidate id, especially when nearby candidates are close together.",
];

const SMALL_GEMMA_OCR_DUPLICATE_LINES = [
  "Each candidate id is single-use. A candidate rectangle can produce at most one output record, even when the text has several vertical columns or several visible lines.",
  "Do not create another record whose bbox sits on the same place as an accepted candidate. If the text is inside or mostly inside a candidate rectangle, it belongs to that candidate id.",
  "Before adding any new record, compare it against every candidate bbox. If the new bbox would cover the same glyph cluster or the same visual text area as a candidate, keep the candidate record only.",
  "If one OCR candidate covers several Japanese lines or columns inside the same visual container, keep them as one record for that candidate; do not split them into multiple overlapping records.",
  "New ids are for genuinely missed text only, not for correcting, enlarging, summarizing, or re-reading an existing candidate. If a candidate needs a better jp/ko, fix that candidate record with the same id.",
  "A new id is invalid if its jp repeats, partially repeats, or summarizes text already assigned to a candidate or earlier record in the same speech bubble/caption/SFX area.",
];

const OVERLAY_OUTPUT_SCHEMA = [
  "id: <integer>",
  "type: nonsolid",
  "textRole: <ordinary|sound>",
  "x1: <integer>",
  "y1: <integer>",
  "x2: <integer>",
  "y2: <integer>",
  "direction: <horizontal|vertical>",
  "angle: <integer>",
  "fontSize: <integer>",
  "confidence: <0.00-1.00>",
  "jp: <visible Japanese source text>",
  "ko: <concise Korean translation>",
].join("\n");

/** @type {PromptSection[]} */
const OVERLAY_PROMPT_SECTIONS = [
  [
    "Task",
    "You are given the same Japanese manga page in multiple full-page renderings.",
    "Image 1 is the coordinate-authority full page. Assist images are only for reading the same page.",
    "Detect every visible Japanese text group and translate it into concise Korean.",
    "Scan the entire page before writing records; do not stop after the first obvious text.",
    "First identify the exact Japanese glyph strokes for each item, then write the record. Do not estimate from the speech bubble or panel shape.",
    "Before reading dialogue text, segment the visible speech balloons themselves. Each distinct balloon lobe and each separated dialogue text cluster becomes a separate dialogue record.",
    "Only output real Japanese text. Do not output decorative line art, background marks, panel ornaments, texture, or unreadable marks as text.",
  ],
  [
    "Output",
    "Return plain text records only. Do not output JSON, markdown, bullets, commentary, or code fences.",
    "Use exactly these keys, one per line: id, type, textRole, x1, y1, x2, y2, direction, angle, fontSize, confidence, jp, ko.",
    "Do not copy placeholder text. Estimate every value from the actual glyphs in Image 1.",
    "textRole is ordinary for speech bubbles, captions, narration, labels, signs, and notes. textRole is sound only for standalone printed sound/reaction lettering.",
    "A word or phrase inside a speech bubble, caption, note, sign, or label remains ordinary even when it is short, vertical, handwritten, or visually casual.",
    "confidence is your confidence from 0.00 to 1.00 that the item is real Japanese text, correctly read, correctly typed, and correctly translated.",
    "Use confidence below 0.72 when the crop is hard to read, partly clipped, possibly decorative, or the translation may be uncertain.",
    "For textRole sound, default to confidence below 1.00. Use confidence 1.00 only for complete, common, unmistakable SFX where the Japanese reading and Korean sound lettering are both certain. If any part is doubtful, use confidence below 1.00; the app will discard uncertain sound-effect records.",
    "If jp has multiple visible source lines, put every readable source line in jp. Continuation lines after jp: belong to jp until the ko: key.",
    "Write ko as natural Korean for horizontal reading. Do not mirror Japanese vertical line breaks; use commas or short Korean phrases unless a real list or dialogue pause needs a line break.",
    "If the entire jp or ko would be only [?], skip that record instead of outputting an unreadable placeholder.",
    "Skip records whose jp is only punctuation, decorative marks, page numbers, a lone Latin letter, or a clipped one-character fragment. Do not output such scraps as standalone records.",
    "If a stylized SFX looks like a Latin letter but is probably Japanese kana, re-read it as kana. If you still cannot read it as Japanese, skip it rather than translating the Latin letter.",
    "Put one blank line between records.",
    "Record template:",
    OVERLAY_OUTPUT_SCHEMA,
  ],
  [
    "Geometry",
    "Coordinates are integers in the coordinate frame described above, with top-left origin.",
    "x1, y1, x2, y2 describe the tight rectangle corners of the visible Japanese glyph ink and its outline.",
    "For each item, first find the four extremes of the complete jp text: leftmost visible glyph/outline pixel, topmost pixel, rightmost pixel, and bottommost pixel. Then output x1 = left, y1 = top, x2 = right, y2 = bottom.",
    "The rectangle must cover every visible stroke, outline, dakuten mark, punctuation mark, small kana, long vowel mark, and trailing kana belonging to jp.",
    "A tight rectangle may still have a tiny 1-3 px safety margin around glyph ink; missing any stroke outside the box is worse than including a hair of surrounding paper.",
    "For vertical Japanese text, the rectangle should cover the union of all vertical glyph columns, from the rightmost visible stroke to the leftmost visible stroke and from the topmost glyph to the bottommost punctuation.",
    "For multi-column vertical text, do not box only the first column, center column, or top half. The bbox is invalid if any character from jp would remain outside x1..x2 or y1..y2.",
    "For one or two vertical text columns, keep w close to the actual glyph-column width, but never make it narrower than the full visible strokes.",
    "Never include the whole speech bubble, caption plate, panel, background art, motion lines, or blank margin.",
    "Never enlarge, shift, or reshape the rectangle to make Korean easier to fit.",
    "fontSize is the apparent Japanese glyph size in Image 1 pixels.",
    "fontSize is the height of one normal full-size source character, not the Korean overlay size and not a template default.",
    "For mixed handwriting, use the main readable glyph size; do not reduce fontSize because small furigana, punctuation, or thin strokes are present.",
    "direction is the original Japanese glyph writing direction: horizontal or vertical. This is about the Japanese source text, not the Korean rendering.",
    "For ordinary speech/caption/label text, Korean rendering should be horizontal by default even when the Japanese source direction is vertical. Do not choose vertical Korean just because the source bbox is tall.",
    "Only reserve vertical Korean for rare non-sound text that truly cannot be read reasonably as horizontal text.",
    "angle is the visible glyph slant in degrees from -30 to 30. Use 0 for upright text.",
    "Before final output, mentally fill each bbox with translucent color: no Japanese glyph from jp should remain visible outside that filled area.",
    "Then check tightness: if the filled area covers large blank bubble paper or caption-box padding on any side, redraw the bbox tighter around the glyph ink.",
    "Then check placement: the center of the bbox must lie on or very near the jp glyph ink cluster, not on adjacent background art or empty panel space.",
    "Decorative hearts, bubble tails, panel borders, box borders, background textures, and motion effects are not Japanese glyph ink.",
  ],
  [
    "Segmentation",
    "Each speech bubble is one dialogue item. Adjacent or touching speech bubbles must stay separate.",
    "If two white balloon lobes touch, overlap, stack vertically, or connect through a narrow neck, still treat them as separate dialogue items.",
    "If one visible outline contains upper and lower lobes with a narrow waist, large blank gap, or two separate text clusters, split it into one record per lobe/text cluster.",
    "Do not create one tall dialogue bbox spanning stacked upper/lower bubbles.",
    "Do not merge two speech bubbles just because the sentence continues across them; split jp and ko by the visible balloon/lobe that contains each text group.",
    "Inside one speech bubble, group all Japanese glyph lines from that same bubble into one item.",
    "Process panels and bubbles exhaustively from top to bottom and right to left.",
    "For captions and narration boxes, box only the printed glyphs, not the surrounding box.",
    "For SFX, box only the sound-effect glyph strokes and their visible outline, not speed lines or impact effects.",
    "For long horizontal SFX, include the entire sound from first glyph through final kana, including stretched lines, detached outline tips, and the last small/isolated character.",
    "For outlined SFX, the bbox follows the outermost visible contour of the outline, not only the dark center stroke.",
    "SFX is often gray, slanted, outlined, partly behind characters, or outside OCR candidates. Do a separate SFX pass after dialogue/captions and add every clear kana sound effect.",
    "Do not invent SFX from sweat drops, vertical panel trim, furniture lines, wall patterns, texture, impact lines, or isolated non-character strokes.",
    "Do not add records for isolated symbol fragments, stray decorative marks, page numbers, or clipped scraps that are not complete Japanese text.",
    "Include meaningful short interjections, names, captions, and SFX.",
  ],
  [
    "Rendering hints",
    "type must always be nonsolid. The app uses one inpainting path for every text block, including speech bubbles, captions, labels, handwriting, and SFX.",
    "textRole must be ordinary for speech bubbles, captions, narration, labels, signs, and notes. textRole must be sound only for standalone printed sound/reaction lettering.",
    "For ordinary textRole, write ko as natural horizontal Korean. Do not keep Japanese vertical line breaks and do not force Korean vertical reading.",
    "For ordinary textRole, translate the Japanese lexical meaning. Never replace an ordinary word, noun, label, or dialogue fragment with a Korean sound effect.",
    "Short kana, handwritten words, or tall vertical bbox shapes are not enough to make textRole sound. First ask whether the text is actual language in a normal container.",
    "For sound-effect or reaction lettering, ko must be bare Korean effect lettering only: no parentheses, brackets, quotes, stage directions, action descriptions, or explanatory notes.",
    "For sound-effect or reaction lettering, translate the visual sound/reaction text itself, not the character's motion or the scene description.",
    "First decide whether the source is ordinary language or standalone printed sound/reaction lettering. Ordinary language can be translated as Korean text; printed sound/reaction lettering must stay as sound lettering.",
    "For every SFX, accuracy and omission are more important than coverage. Most SFX should be omitted or set below confidence 1.00 unless the exact source glyphs, the sound class, and the Korean effect lettering are all clear.",
    "This uncertainty rule applies to all SFX: small, large, outlined, gray, slanted, handwritten, background, UI-adjacent, repeated, or partly hidden. Do not limit caution to large bold SFX.",
    "Never give confidence 1.00 to an SFX by guessing from scene context alone, by reading a stylized mark as a familiar kana shape without certainty, or by choosing a generic Korean effect word.",
    "When reviewing a previous-pass SFX, do not preserve its Korean wording for stability. Re-read the image from scratch; if the previous SFX sounds clumsy, too long, generic, or merely possible, lower confidence below 1.00 or skip it.",
    "Do not output confidence 1.00 for SFX translations like 달그락달그락, 덜그럭덜그럭, 쿵, 툭, or 고오 unless the exact source glyph and scene clearly demand that Korean sound. A plausible guess is not enough.",
    "SFX translation priority: choose compact Korean effect lettering that fits the scene and visible rhythm. Do not mechanically transliterate Japanese kana when that would sound awkward in Korean.",
    "Do not force every SFX into semantic Korean. Avoid action verbs, adverbs, and explanations; when no clean localized effect word exists, use the shortest Korean sound lettering that still feels natural on the page.",
    "Large bold SFX should stay short and punchy. Do not replace one large visual SFX glyph group with a long repeated Korean phrase just because the Japanese hint is repeated.",
    "Avoid long Korean clatter words such as 달그락달그락 or 덜그럭덜그럭 unless the image clearly shows small hard objects continuously clattering. For dramatic impact, shock, pressure, or a sudden UI/body reaction, choose a shorter force sound.",
    "For ガタ, ガタッ, or ガタガタ, choose by scene: trembling/shock can be 덜덜 or 덜컥, sudden movement can be 덜컹, but do not default to 달그락달그락.",
    "For ゴ, ゴッ, ゴゴ, or other large heavy black impact lettering, use a short heavy sound such as 쿵, 쿠궁, or 고오 when context supports it; do not soften it into 툭 or stretch it into a clatter phrase.",
    "Do not translate ambient SFX as spoken dialogue. Treat it as printed sound/reaction lettering unless the visible text is clearly an actual spoken line.",
    "For motion, impact, cutting, texture, and ambient SFX, infer the sound class from image context and lettering shape. If the scene is unclear, keep the sound texture instead of choosing an unrelated meaning.",
    "For repeated or lengthened SFX, preserve the visible rhythm and duration in compact Korean instead of collapsing it into a generic word.",
    "Repeated Japanese SFX does not automatically mean repeated Korean syllables. If the visual lettering is one large impact group, one compact Korean sound is usually better than a long repeated phrase.",
    "For printed sound/reaction lettering, ko should be readable aloud as a sound printed on the page. It must not be an adverbial phrase, narration, action description, emotion description, or sentence.",
    "For printed sound/reaction lettering, avoid Korean grammar endings, particles, connective endings, and explanatory spacing. Prefer one compact sound string over a phrase.",
    "For printed sound/reaction lettering, confidence must be below 1.00 by default. It may be 1.00 only for a complete, clearly read SFX with a clearly correct Korean sound. Any clipped, decorative, ambiguous, partially read, style-uncertain, or translation-uncertain SFX must have confidence below 1.00.",
    "If the source lettering includes a grammatical connector after a sound, translate only the sound value unless the entire visible source is ordinary language.",
    "Do not translate a single SFX by describing the surrounding action, emotion, or speaker. The overlay text should read like a sound printed on the page.",
    "Do not output isolated fragments as separate records. Skip punctuation, decorative marks, digits, page numbers, lone Latin letters, isolated small kana/sokuon, or clipped single-character scraps unless they are clearly a complete visible text item.",
    "Prefer dropping a doubtful decorative or fragmentary mark over producing a confident but meaningless translation.",
    "Do not translate partial SFX strokes or decorative fragments as dictionary words. Attach incomplete strokes to their neighboring glyphs or skip them if they are not a complete readable item.",
    "Keep SFX ko very short, usually one compact sound phrase. Avoid explaining who moved, what happened, or why.",
    "Use angle 0 for ordinary upright speech and captions; use a nonzero angle only when the source glyphs are visibly slanted.",
    "Keep Korean short enough for an on-image overlay while preserving meaning.",
    "For handwritten diagrams and search-word lists, translate the whole note as one compact Korean phrase or comma-separated list when possible.",
    "If OCR is uncertain for ordinary text, write [?] only for the uncertain fragment and still output the item. For SFX, do not output a guessed [?] record; skip it or use confidence below 1.00.",
  ],
];

const PROMPT_KO_BBOX_LINES_MULTIVIEW = buildOverlayPrompt();

/**
 * @param {PromptOptions} [options]
 * @returns {string}
 */
function buildSystemPrompt(options = {}) {
  const lines = [
    "You are an OCR and manga-translation engine.",
    "Return only the machine-readable record format requested by the user prompt.",
    "Geometry accuracy comes before Korean text fit: preserve the original Japanese glyph position and apparent size.",
    "Never merge separate speech bubbles, including touching or stacked balloon lobes.",
    "Never output duplicate or overlapping records for the same physical Japanese text area. One glyph cluster/container must become one record, not stacked blocks.",
    "Render ordinary speech/caption/label Korean horizontally by default; source Japanese vertical direction is not a reason to make Korean vertical.",
    "For SFX records, output bare Korean effect lettering only; do not wrap it in parentheses/brackets/quotes or turn it into a stage direction.",
    "For SFX records, choose compact Korean effect lettering that fits the scene and rhythm. Do not mechanically transliterate Japanese kana, and do not force ambient sounds into dialogue words or action descriptions.",
    "For SFX records, confidence is below 1.00 by default. Use confidence 1.00 only when the complete sound effect is unquestionably real Japanese text, fully read, and clearly translated into a fitting Korean sound; otherwise use confidence below 1.00 so the app drops it.",
  ];

  if (options.strictRefineMode) {
    lines.push(
      "Strict refinement pass: previous Korean blocks are weak review hints only, not source text. Correct an existing physical text area in place; do not add a second record for it.",
      "In strict refinement, new ids are exceptional and valid only for complete visible Japanese glyph groups clearly outside every OCR candidate.",
    );
  }

  if (options.regionCropMode) {
    lines.push(
      "Selected-region mode: group by visual text container, not by line or column. One speech bubble or one caption plate is one item even when the Japanese is split across multiple vertical columns or lines.",
    );
  }

  return lines.join("\n\n");
}

/**
 * @param {PromptOptions} [options]
 * @param {ImageVariant[]} [imageVariants]
 * @returns {string}
 */
function buildOverlayPrompt(options = {}, imageVariants = []) {
  const sections = OVERLAY_PROMPT_SECTIONS.map(([title, ...lines]) => [
    title,
    ...lines,
  ]);
  sections[0] = buildTaskSection(options, imageVariants);
  applyModelSpecificPromptProfile(sections, options);
  const regionCropSection = buildRegionCropSection(options);
  if (regionCropSection.length > 1) {
    sections.splice(1, 0, regionCropSection);
  }
  const coordinateSection = buildCoordinateCalibrationSection(
    options,
    imageVariants,
  );
  if (coordinateSection.length > 1) {
    sections.splice(2, 0, coordinateSection);
  }
  const strictRefineSection = buildStrictRefineSection(options);
  if (strictRefineSection.length > 1) {
    const coordinateIndex = sections.findIndex(
      (section) => section[0] === "Coordinate calibration",
    );
    sections.splice(
      coordinateIndex === -1 ? 2 : coordinateIndex + 1,
      0,
      strictRefineSection,
    );
  }
  const workContextSection = buildWorkContextSection(options);
  if (workContextSection.length > 1) {
    const strictIndex = sections.findIndex(
      (section) => section[0] === "Strict refinement mode",
    );
    const coordinateIndex = sections.findIndex(
      (section) => section[0] === "Coordinate calibration",
    );
    sections.splice(
      strictIndex === -1
        ? coordinateIndex === -1
          ? 2
          : coordinateIndex + 1
        : strictIndex + 1,
      0,
      workContextSection,
    );
  }
  const previousPassSection = buildPreviousPassSection(options, imageVariants);
  if (previousPassSection.length > 1) {
    const workContextIndex = sections.findIndex(
      (section) => section[0] === "Work glossary and story memory",
    );
    const strictIndex = sections.findIndex(
      (section) => section[0] === "Strict refinement mode",
    );
    const coordinateIndex = sections.findIndex(
      (section) => section[0] === "Coordinate calibration",
    );
    sections.splice(
      workContextIndex === -1
        ? strictIndex === -1
          ? coordinateIndex === -1
            ? 2
            : coordinateIndex + 1
          : strictIndex + 1
        : workContextIndex + 1,
      0,
      previousPassSection,
    );
  }
  const ocrHintSection = buildOcrBboxHintSection(options, imageVariants);
  if (ocrHintSection.length > 1) {
    const previousIndex = sections.findIndex(
      (section) => section[0] === "Previous pass blocks",
    );
    const workContextIndex = sections.findIndex(
      (section) => section[0] === "Work glossary and story memory",
    );
    const strictIndex = sections.findIndex(
      (section) => section[0] === "Strict refinement mode",
    );
    const coordinateIndex = sections.findIndex(
      (section) => section[0] === "Coordinate calibration",
    );
    sections.splice(
      previousIndex === -1
        ? workContextIndex === -1
          ? strictIndex === -1
            ? coordinateIndex === -1
              ? 2
              : coordinateIndex + 1
            : strictIndex + 1
          : workContextIndex + 1
        : previousIndex + 1,
      0,
      ocrHintSection,
    );
  }

  return sections
    .map(([title, ...lines]) => [`# ${title}`, ...lines].join("\n"))
    .join("\n\n");
}

/**
 * @param {PromptSection[]} sections
 * @param {PromptOptions} [options]
 * @returns {void}
 */
function applyModelSpecificPromptProfile(sections, options = {}) {
  insertSectionLinesBefore(
    sections,
    "Output",
    "Do not copy placeholder text. Estimate every value from the actual glyphs in Image 1.",
    SMALL_GEMMA_DUPLICATE_OUTPUT_LINES,
  );
  insertSectionLinesAfter(
    sections,
    "Segmentation",
    "Inside one speech bubble, group all Japanese glyph lines from that same bubble into one item.",
    SMALL_GEMMA_DUPLICATE_SEGMENTATION_LINES,
  );

  if (!shouldUseSmallGemmaDuplicatePromptProfile(options)) {
    return;
  }
}

/**
 * @param {PromptSection[]} sections
 * @param {string} title
 * @param {string} anchorLine
 * @param {string[]} lines
 * @returns {void}
 */
function insertSectionLinesBefore(sections, title, anchorLine, lines) {
  const section = sections.find((candidate) => candidate[0] === title);
  if (!section) {
    return;
  }
  const index = section.indexOf(anchorLine);
  section.splice(index === -1 ? section.length : index, 0, ...lines);
}

/**
 * @param {PromptSection[]} sections
 * @param {string} title
 * @param {string} anchorLine
 * @param {string[]} lines
 * @returns {void}
 */
function insertSectionLinesAfter(sections, title, anchorLine, lines) {
  const section = sections.find((candidate) => candidate[0] === title);
  if (!section) {
    return;
  }
  const index = section.indexOf(anchorLine);
  section.splice(index === -1 ? section.length : index + 1, 0, ...lines);
}

/**
 * @param {PromptOptions} [options]
 * @param {ImageVariant[]} [imageVariants]
 * @returns {string}
 */
function getOverlayPrompt(options = {}, imageVariants = []) {
  return buildOverlayPrompt(options, imageVariants);
}

/**
 * @param {PromptOptions} [options]
 * @param {ImageVariant[]} [imageVariants]
 * @returns {PromptSection}
 */
function buildTaskSection(options = {}, imageVariants = []) {
  const hasAssistImages = imageVariants.length > 1;
  const regionCropMode = Boolean(options.regionCropMode);
  const strictRefineMode = Boolean(options.strictRefineMode);
  return [
    "Task",
    hasAssistImages
      ? "You are given the same Japanese manga page in multiple full-page renderings."
      : regionCropMode
        ? "You are given one user-selected crop from a Japanese manga page."
        : "You are given one full-page Japanese manga image.",
    hasAssistImages
      ? "Image 1 is the coordinate-authority full page. Assist images are only for reading the same page."
      : regionCropMode
        ? "Image 1 is the coordinate-authority selected crop."
        : "Image 1 is the coordinate-authority full page.",
    "Detect every visible Japanese text group and translate it into concise Korean.",
    ...(strictRefineMode
      ? [
          "This is a strict second-pass refinement. Treat OCR candidate slots as the main output slots, and use previous pass blocks only as weak review hints.",
          "Do not re-detect the page from scratch in a way that duplicates existing OCR candidates or previous physical text areas.",
        ]
      : []),
    "Scan the entire page before writing records; do not stop after the first obvious text.",
    "First identify the exact Japanese glyph strokes for each item, then write the record. Do not estimate from the speech bubble or panel shape.",
    "Before reading dialogue text, segment the visible speech balloons themselves. Each distinct balloon lobe and each separated dialogue text cluster becomes a separate dialogue record.",
    "Only output real Japanese text. Do not output decorative line art, background marks, panel ornaments, texture, or unreadable marks as text.",
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

  return [
    "Strict refinement mode",
    "This pass improves an existing Korean overlay result. It should be conservative and stable.",
    "Priority order: 1. Image 1 visible Japanese glyphs, 2. OCR candidate bbox/id/group, 3. work glossary/story memory, 4. previous pass jp/ko.",
    "Existing OCR candidate ids are the main output slots. For the same physical Japanese text area, keep the same candidate id whenever an OCR candidate exists.",
    "Previous pass blocks are weak review hints only. They are not visible Japanese source text and must never create a record by themselves.",
    "Use previous Korean wording only when it naturally matches the same visible Japanese glyph area. Correct it when Image 1, OCR, glossary, story memory, or SFX context proves a better result.",
    "For previous-pass SFX, do not preserve Korean wording for stability. Re-read the source glyphs from Image 1. If the SFX reading or Korean sound choice is not clearly right, output confidence below 1.00 or omit it.",
    "Never add a new record to correct, restate, enlarge, re-read, or provide an alternate translation for an existing OCR candidate or previous physical text area. Correct the existing record instead.",
    "New ids are exceptional. A new id is valid only when a complete Japanese glyph cluster is clearly visible outside every OCR candidate box and is not a duplicate of any previous block.",
    "A new SFX record is valid only when the complete source glyph group is clearly Japanese kana/kanji, fully visible, outside OCR candidates, and output as textRole sound. Dots, dashes, Latin letters, digits, panel lines, and decorative strokes are invalid.",
  ];
}

/**
 * @param {PromptOptions} [options]
 * @param {ImageVariant[]} [imageVariants]
 * @returns {PromptSection}
 */
function buildPreviousPassSection(options = {}, imageVariants = []) {
  const blocks = Array.isArray(options.previousBlocksForPrompt)
    ? options.previousBlocksForPrompt
    : [];
  if (!options.strictRefineMode || blocks.length === 0) {
    return [];
  }

  return [
    "Previous pass blocks",
    "These are weak review hints from the previous Korean overlay pass. Do not output them as records unless Image 1 shows real Japanese glyphs at the same physical area.",
    "They are useful for preserving good Korean wording, spotting bad splits/merges, and avoiding accidental deletion, but they are lower priority than Image 1 and OCR candidates.",
    "If a previous block and an OCR candidate describe the same physical area, output the OCR candidate id, not a separate previous-block record.",
    "If Image 1 does not show Japanese glyphs at a previous block location, ignore that previous block.",
    ...blocks
      .slice(0, 80)
      .map((block, index) =>
        formatPreviousPassBlock(block, index + 1, options, imageVariants),
      )
      .filter(Boolean),
  ];
}

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
  const glossary = Array.isArray(guide.glossary)
    ? guide.glossary.filter((entry) => entry && entry.enabled !== false)
    : [];
  const characters = Array.isArray(guide.characters)
    ? guide.characters.filter((entry) => entry && entry.enabled !== false)
    : [];
  const recentPages = Array.isArray(context.storyMemory?.pages)
    ? context.storyMemory.pages
    : [];
  const rules = guide.rules || {};
  const lines = [
    "Work glossary and story memory",
    "Do not output these notes as records.",
  ];

  if (glossary.length > 0) {
    lines.push(
      "Use these glossary entries for consistency. If the source text matches an entry or alias, prefer the target Korean exactly unless Image 1 clearly proves a different meaning.",
    );
    for (const entry of glossary.slice(0, 80)) {
      lines.push(formatGlossaryEntry(entry));
    }
  }

  if (characters.length > 0) {
    lines.push(
      "Character/name memory. Keep names and speech style consistent when translating dialogue.",
    );
    for (const character of characters.slice(0, 40)) {
      lines.push(formatCharacterEntry(character));
    }
  }

  if (recentPages.length > 0) {
    lines.push(
      "Recent story context from previous pages. Use it only to resolve pronouns, omitted subjects, relationships, tone, and continuity. Do not output these notes as records.",
    );
    for (const page of recentPages.slice(-6)) {
      lines.push(
        `- p${Number(page.pageIndex) + 1} ${sanitizePromptLine(page.pageName)}: ${sanitizePromptLine(page.summary || page.translatedDigest || "")}`,
      );
    }
  }

  lines.push(
    `Rules: honorifics=${rules.honorifics || "adapt"}, sfxMode=${rules.sfxMode || "translate"}, defaultTone=${rules.defaultTone || "natural_korean"}.`,
  );
  return lines.length > 1 ? lines : [];
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

/**
 * @param {PreviousPromptBlock} block
 * @param {number} fallbackIndex
 * @param {PromptOptions} [options]
 * @param {ImageVariant[]} [imageVariants]
 * @returns {string}
 */
function formatPreviousPassBlock(
  block,
  fallbackIndex,
  options = {},
  imageVariants = [],
) {
  if (!block || typeof block !== "object") {
    return "";
  }
  const index = readPositiveInteger(block.index) || fallbackIndex;
  const bbox = convertPreviousBboxToPromptFrame(
    block.bbox,
    options,
    imageVariants,
  );
  if (!bbox) {
    return "";
  }
  const candidateId = readPositiveInteger(block.candidateId);
  const candidate = candidateId ? ` candidateId:${candidateId}` : "";
  const role = sanitizePromptLine(block.textRole || "ordinary", 40);
  const confidence = Number(block.confidence);
  const confidenceText = Number.isFinite(confidence)
    ? ` confidence:${Math.round(confidence * 100) / 100}`
    : "";
  const jp = sanitizePromptLine(block.sourceText, 160);
  const ko = sanitizePromptLine(block.translatedText, 160);
  return `previous ${index}:${candidate} bbox:[${bbox.x1},${bbox.y1},${bbox.x2},${bbox.y2}] role:${role}${confidenceText} jp:${JSON.stringify(jp)} ko:${JSON.stringify(ko)}`;
}

/**
 * @param {PromptBbox | undefined} bbox
 * @param {PromptOptions} [options]
 * @param {ImageVariant[]} [imageVariants]
 * @returns {{ x1: number; y1: number; x2: number; y2: number } | null}
 */
function convertPreviousBboxToPromptFrame(
  bbox,
  options = {},
  imageVariants = [],
) {
  if (!bbox || typeof bbox !== "object") {
    return null;
  }
  const x = Number(bbox.x);
  const y = Number(bbox.y);
  const w = Number(bbox.w);
  const h = Number(bbox.h);
  if (![x, y, w, h].every(Number.isFinite)) {
    return null;
  }
  const frame = resolvePromptCoordinateFrame(options, imageVariants);
  const left = Math.min(x, x + w);
  const top = Math.min(y, y + h);
  const right = Math.max(x, x + w);
  const bottom = Math.max(y, y + h);
  if (frame.space === "pixels") {
    return {
      x1: Math.round((left / 1000) * frame.frame.width),
      y1: Math.round((top / 1000) * frame.frame.height),
      x2: Math.round((right / 1000) * frame.frame.width),
      y2: Math.round((bottom / 1000) * frame.frame.height),
    };
  }
  return {
    x1: Math.round(left),
    y1: Math.round(top),
    x2: Math.round(right),
    y2: Math.round(bottom),
  };
}

/**
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function sanitizePromptLine(value, max = 240) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= max
    ? text
    : `${text.slice(0, Math.max(0, max - 3))}...`;
}

/**
 * @param {PromptOptions} [options]
 * @returns {PromptSection}
 */
function buildRegionCropSection(options = {}) {
  if (!options.regionCropMode) {
    return [];
  }

  return [
    "Selected region grouping",
    "This image is a crop selected by the user, so there may be one speech bubble, part of one bubble, multiple bubbles, captions, or SFX inside it.",
    "Do not treat the whole crop as one text item. Create multiple records only for multiple visually separate containers: separate speech bubbles/lobes, separate caption plates, or separate SFX glyph groups.",
    "If the crop contains one speech bubble or one caption plate, output exactly one record for all readable Japanese in that container.",
    "Inside one speech bubble, never split by Japanese vertical column, text line, word, sentence fragment, punctuation gap, or line break.",
    "For vertical dialogue in one bubble, jp must include all columns in natural Japanese reading order, and ko must be one coherent Korean translation for that bubble.",
    "Only split a dialogue item when there is a visible separate speech bubble/lobe or clearly separate dialogue container, not merely because columns are separated by blank paper.",
    "The bbox for that one record should tightly cover the union of all visible Japanese glyph ink belonging to the same bubble/caption, not the whole bubble paper.",
  ];
}

/**
 * @param {PromptOptions} [options]
 * @param {ImageVariant[]} [imageVariants]
 * @returns {PromptSection}
 */
function buildCoordinateCalibrationSection(options = {}, imageVariants = []) {
  const originalWidth = readPositiveInteger(options.imageWidth);
  const originalHeight = readPositiveInteger(options.imageHeight);
  const geometryVariant =
    imageVariants.find((variant) => variant.role === "openai-vision") ||
    imageVariants[0];
  const sentWidth = readPositiveInteger(geometryVariant?.width);
  const sentHeight = readPositiveInteger(geometryVariant?.height);
  const coordinateFrame = resolvePromptCoordinateFrame(options, imageVariants);
  if (!originalWidth || !originalHeight) {
    return [];
  }

  const lines = [
    "Coordinate calibration",
    `The original page is ${originalWidth}x${originalHeight} px.`,
  ];

  if (coordinateFrame.space === "pixels") {
    lines.push(
      `Image 1 was prepared before the API call to match the OpenAI detail: original vision frame, so the model sees Image 1 as ${coordinateFrame.frame.width}x${coordinateFrame.frame.height} px.`,
      `Return x1, y1, x2, y2 as integer pixel coordinates in that ${coordinateFrame.frame.width}x${coordinateFrame.frame.height} Image 1 frame.`,
      "Do not return width/height, original-page pixels, normalized 0..1000 coordinates, viewport coordinates, crop coordinates, tile coordinates, or model-internal coordinates.",
      `Use the full visible Image 1 frame as the coordinate frame: left edge 0, top edge 0, right edge ${coordinateFrame.frame.width}, bottom edge ${coordinateFrame.frame.height}.`,
      "The app will map these sent-image pixels back to the original page after the model response.",
    );
    return lines;
  }

  lines.push(
    "Return x1, y1, x2, y2 as normalized 0..1000 corner coordinates over Image 1, not viewport, crop, tile, or model-internal coordinates.",
    "Use the full visible Image 1 frame as the coordinate frame: left edge 0, top edge 0, right edge 1000, bottom edge 1000.",
    "Because Image 1 preserves the original aspect ratio, these normalized coordinates map directly back to the original page.",
  );

  if (
    sentWidth &&
    sentHeight &&
    (sentWidth !== originalWidth || sentHeight !== originalHeight)
  ) {
    lines.push(
      `For OpenAI vision, Image 1 was pre-scaled to ${sentWidth}x${sentHeight} px for detail: original before sending so the coordinate frame matches what the model sees.`,
      `If measuring in sent pixels, convert directly with x1 = round(left * 1000 / ${sentWidth}), y1 = round(top * 1000 / ${sentHeight}), x2 = round(right * 1000 / ${sentWidth}), y2 = round(bottom * 1000 / ${sentHeight}).`,
    );
  }

  return lines;
}

/**
 * @param {PromptOptions} [options]
 * @param {ImageVariant[]} [imageVariants]
 * @returns {PromptSection}
 */
function buildOcrBboxHintSection(options = {}, imageVariants = []) {
  const hints = Array.isArray(options.ocrBboxHints) ? options.ocrBboxHints : [];
  if (hints.length === 0) {
    return [];
  }

  const frame = resolvePromptCoordinateFrame(options, imageVariants);
  const originalWidth = readPositiveInteger(options.imageWidth);
  const originalHeight = readPositiveInteger(options.imageHeight);
  const formattedHints = hints
    .slice(0, 80)
    .map((hint, index) =>
      formatOcrBboxHintForPrompt(
        hint,
        index + 1,
        frame,
        originalWidth,
        originalHeight,
      ),
    )
    .filter(Boolean);
  const candidateIds = hints
    .slice(0, formattedHints.length)
    .map((hint, index) => readPositiveInteger(hint.id) || index + 1);
  const maxCandidateId = Math.max(...candidateIds, 0);
  const groupContextLines = buildOcrGroupContextLines(
    hints.slice(0, formattedHints.length),
  );

  if (formattedHints.length === 0) {
    return [];
  }

  const useSmallGemmaDuplicateProfile =
    shouldUseSmallGemmaDuplicatePromptProfile(options);
  const strictRefineMode = Boolean(options.strictRefineMode);
  const useStrictDuplicateRules =
    strictRefineMode || useSmallGemmaDuplicateProfile;
  const ocrAnchorLines = useStrictDuplicateRules
    ? SMALL_GEMMA_OCR_ANCHOR_LINES
    : [
        "OCR text hints may be wrong, incomplete, or split strangely. Use Image 1 as the authority for the actual Japanese text and Korean translation.",
        "Use the OCR text hint to keep each translated record attached to the correct candidate id, especially when nearby candidates are close together.",
      ];
  const candidateChangeLine = useStrictDuplicateRules
    ? "You may change a candidate bbox only when Image 1 clearly proves the candidate clips visible glyph strokes or includes non-text art; then change the minimum amount needed and keep the same id."
    : "You may change a candidate bbox only when Image 1 clearly proves the candidate clips visible glyph strokes or includes non-text art; then change the minimum amount needed.";
  const missingTextIntroLines = strictRefineMode
    ? [
        "In strict refinement, OCR candidates are the main output slots. After processing candidates, inspect Image 1 only for obvious missing Japanese text that is fully outside all candidate rectangles.",
        `If the detector missed visible Japanese text, add a new record with id greater than ${maxCandidateId}. New ids are exceptional and must never correct, restate, enlarge, or duplicate an existing candidate.`,
        "A new record is invalid if its bbox overlaps an OCR candidate, its center sits inside an OCR candidate, or its jp repeats text already assigned to a candidate or earlier record.",
        "For new missing SFX records, be very conservative: add them only when the complete kana/SFX glyph group is clearly visible, fully outside every candidate, the exact source reading is clear, and the Korean sound choice is certain enough for confidence 1.00.",
        "Never add new ordinary records for dots, dashes, ellipses, Latin letters, digits, UI fragments, panel trim, furniture lines, wall patterns, or isolated strokes.",
      ]
    : useSmallGemmaDuplicateProfile
      ? [
          "OCR candidates are the normal source of output records. After processing candidates, inspect Image 1 only for obvious missing Japanese text that is clearly outside all candidate rectangles.",
          `If the detector missed visible Japanese text, add a new record with id greater than ${maxCandidateId}. Never reuse a candidate id for missing text outside that candidate rectangle, and never add a new id for text already covered by a candidate.`,
        "New records are allowed only for clear Japanese glyphs whose bbox does not overlap existing candidate rectangles except for a tiny edge touch.",
        "For new missing SFX records, be conservative: add them only when the complete kana/SFX glyph group is clearly visible and not covered by any candidate. The bbox must visibly cover kana/SFX glyph strokes.",
      ]
    : [
        "OCR candidates are a floor, not a ceiling. After processing candidates, inspect the whole Image 1 again for missing Japanese text.",
        `If the detector missed visible Japanese text, add a new record with id greater than ${maxCandidateId}. Never reuse a candidate id for missing text outside that candidate rectangle.`,
        "New records are allowed only for clear Japanese glyphs that are not covered by any candidate.",
        "For new missing SFX records, search especially near character bodies, panel edges, and lower panels where OCR often misses gray or outlined kana. The bbox must visibly cover kana/SFX glyph strokes.",
      ];

  return [
    "OCR bbox candidates",
    "An external OCR geometry detector has already proposed bbox candidates. Some candidates include low-trust OCR text hints for slot matching only.",
    ...ocrAnchorLines,
    "Treat each candidate as a locked geometry slot. For every candidate that contains Japanese glyphs, output one record with that same id and the exact x1, y1, x2, y2 numbers shown below.",
    ...(useStrictDuplicateRules
      ? [SMALL_GEMMA_OCR_DUPLICATE_LINES[0]]
      : []),
    `Required candidate ids: ${candidateIds.join(", ")}.`,
    ...groupContextLines,
    "Read and translate only the text inside that candidate rectangle plus a tiny visual margin; do not move the rectangle to a different nearby text group.",
    ...(useStrictDuplicateRules
      ? SMALL_GEMMA_OCR_DUPLICATE_LINES.slice(1)
      : []),
    "For each candidate, read every visible Japanese line inside the rectangle. A candidate record is incomplete if jp or ko contains only the first line while lower or side lines remain readable.",
    "If a candidate is a handwritten note or diagram label, preserve all readable words, but translate ko compactly for horizontal Korean reading rather than copying the Japanese vertical line breaks.",
    "For every accepted candidate, output type nonsolid and set textRole to ordinary or sound.",
    "If a candidate is a sweat drop, texture, decoration, panel trim, or other non-text mark, skip it instead of inventing text.",
    "For candidate SFX, confidence is below 1.00 by default. Use confidence 1.00 only when the complete effect text is clearly read and the Korean sound choice is clearly right; otherwise use confidence below 1.00 so the app drops it.",
    candidateChangeLine,
    "Do not merge two candidates into one record, even when the sentence continues across them. Candidate rectangles are separate output records.",
    "If two candidates are stacked or touching speech bubbles, output two separate dialogue records with their original ids.",
    "For phone/game/menu UI candidates: keep only compact labels such as MENU, Quests, SAVE, or DELETE when they fit the candidate. Do not translate a multi-row UI list or save-slot table as one large Korean block.",
    "For containerType ui_list, phone_ui, menu, settings, or game_ui: keep each candidate compact, treat it as an ordinary UI label, and never create a large new dialogue record covering the UI panel or list.",
    ...missingTextIntroLines,
    "Never add SFX on panel trim, furniture lines, wall patterns, or isolated vertical strokes.",
    "The candidate coordinates below are already converted into the same coordinate frame required for your output.",
    "",
    ...formattedHints,
  ];
}

/**
 * @param {OcrHint[]} hints
 * @returns {PromptSection}
 */
function buildOcrGroupContextLines(hints) {
  const groups = collectOcrHintGroups(hints);
  if (groups.length === 0) {
    return [];
  }

  return [
    "Group context hints:",
    "Some OCR candidates may be separate geometry slots but parts of the same visible utterance or related printed text. Use group context only to read and translate them coherently.",
    "Even inside a group, keep one output record per candidate id; never merge grouped candidate boxes into one record and never move one candidate to another candidate's position.",
    "For grouped candidates, translate each candidate's visible source text as the appropriate part of the group, informed by the whole group reading order.",
    "For grouped ordinary text, first understand the combined Japanese expression in reading order, then split the Korean naturally across the original candidate ids. Do not translate each fragment syllable-by-syllable in isolation.",
    ...groups.map(formatOcrGroupForPrompt),
  ];
}

/**
 * @param {OcrHint[]} hints
 * @returns {OcrHintGroup[]}
 */
function collectOcrHintGroups(hints) {
  /** @type {Map<string, OcrHintGroup>} */
  const grouped = new Map();
  for (const hint of Array.isArray(hints) ? hints : []) {
    const groupId = sanitizeOcrGroupId(hint?.groupId);
    if (!groupId) continue;
    const group = grouped.get(groupId) || {
      groupId,
      rolePrior: sanitizeOcrGroupValue(hint.rolePrior) || "unknown",
      containerType: sanitizeOcrGroupValue(hint.containerType) || "unknown",
      hints: [],
    };
    group.hints.push(hint);
    grouped.set(groupId, group);
  }

  return [...grouped.values()]
    .map((group) => ({
      ...group,
      hints: group.hints
        .slice()
        .sort(
          (left, right) =>
            (readPositiveInteger(left.orderInGroup) || 9999) -
            (readPositiveInteger(right.orderInGroup) || 9999),
        ),
    }))
    .filter((group) => group.hints.length > 1)
    .sort((left, right) => left.groupId.localeCompare(right.groupId))
    .slice(0, 12);
}

/**
 * @param {OcrHintGroup} group
 * @returns {string}
 */
function formatOcrGroupForPrompt(group) {
  const candidateIds = group.hints
    .map((hint) => readPositiveInteger(hint.id))
    .filter(Boolean);
  const readingOrder = group.hints
    .map((hint) => readPositiveInteger(hint.id))
    .filter(Boolean);
  const textPreview = group.hints
    .map((hint) => sanitizeOcrTextForPrompt(readOcrCandidateText(hint)))
    .filter(Boolean)
    .join(" / ");
  const preview = textPreview
    ? ` textPreview:${JSON.stringify(textPreview)}`
    : "";
  return `group ${group.groupId}: rolePrior:${group.rolePrior} containerType:${group.containerType} candidateIds:[${candidateIds.join(",")}] readingOrder:[${readingOrder.join(",")}]${preview}`;
}

/**
 * @param {OcrHint} hint
 * @param {number} fallbackId
 * @param {PromptCoordinateFrame} frame
 * @param {number | null} originalWidth
 * @param {number | null} originalHeight
 * @returns {string}
 */
function formatOcrBboxHintForPrompt(
  hint,
  fallbackId,
  frame,
  originalWidth,
  originalHeight,
) {
  const x1 = Number(hint?.x1);
  const y1 = Number(hint?.y1);
  const x2 = Number(hint?.x2);
  const y2 = Number(hint?.y2);
  if (![x1, y1, x2, y2].every(Number.isFinite)) {
    return "";
  }

  const id = readPositiveInteger(hint.id) || fallbackId;
  const label = sanitizeHintLabel(hint.label);
  const converted = convertOriginalPixelBoxToPromptFrame(
    { x1, y1, x2, y2 },
    frame,
    originalWidth,
    originalHeight,
  );
  const scoreValue = Number(hint.score);
  const score = Number.isFinite(scoreValue)
    ? ` score:${Math.round(scoreValue * 100) / 100}`
    : "";
  const ocrText = sanitizeOcrTextForPrompt(readOcrCandidateText(hint));
  const textHint = ocrText ? ` ocrText:${JSON.stringify(ocrText)}` : "";
  const groupId = sanitizeOcrGroupId(hint.groupId);
  const group = groupId
    ? ` group:${groupId} orderInGroup:${readPositiveInteger(hint.orderInGroup) || 1}`
    : "";
  const rolePrior = sanitizeOcrGroupValue(hint.rolePrior);
  const role = rolePrior ? ` rolePrior:${rolePrior}` : "";
  const containerType = sanitizeOcrGroupValue(hint.containerType);
  const container = containerType ? ` containerType:${containerType}` : "";
  return `candidate ${id}: label:${label} x1:${converted.x1} y1:${converted.y1} x2:${converted.x2} y2:${converted.y2}${score}${group}${role}${container}${textHint}`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeOcrGroupId(value) {
  const text = String(value ?? "")
    .trim()
    .toUpperCase();
  return /^G\d{3,4}$/.test(text) ? text : "";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeOcrGroupValue(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_");
  return text.slice(0, 48);
}

/**
 * @param {PromptBox} box
 * @param {PromptCoordinateFrame} frame
 * @param {number | null} originalWidth
 * @param {number | null} originalHeight
 * @returns {PromptBox}
 */
function convertOriginalPixelBoxToPromptFrame(
  box,
  frame,
  originalWidth,
  originalHeight,
) {
  if (frame.space === "pixels" && originalWidth && originalHeight) {
    const xScale = frame.frame.width / originalWidth;
    const yScale = frame.frame.height / originalHeight;
    return {
      x1: Math.round(Math.min(box.x1, box.x2) * xScale),
      y1: Math.round(Math.min(box.y1, box.y2) * yScale),
      x2: Math.round(Math.max(box.x1, box.x2) * xScale),
      y2: Math.round(Math.max(box.y1, box.y2) * yScale),
    };
  }

  if (originalWidth && originalHeight) {
    return {
      x1: Math.round((Math.min(box.x1, box.x2) / originalWidth) * 1000),
      y1: Math.round((Math.min(box.y1, box.y2) / originalHeight) * 1000),
      x2: Math.round((Math.max(box.x1, box.x2) / originalWidth) * 1000),
      y2: Math.round((Math.max(box.y1, box.y2) / originalHeight) * 1000),
    };
  }

  return {
    x1: Math.round(Math.min(box.x1, box.x2)),
    y1: Math.round(Math.min(box.y1, box.y2)),
    x2: Math.round(Math.max(box.x1, box.x2)),
    y2: Math.round(Math.max(box.y1, box.y2)),
  };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeHintLabel(value) {
  const text = String(value ?? "text")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_");
  return text || "text";
}

/**
 * @param {unknown} candidate
 * @returns {string}
 */
function readOcrCandidateText(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return "";
  }
  const record = /** @type {Record<string, unknown>} */ (candidate);
  for (const key of [
    "ocrText",
    "ocr_text",
    "text",
    "content",
    "block_content",
    "rec_text",
    "transcription",
  ]) {
    const text = normalizeOcrTextValue(record[key]);
    if (text) {
      return text;
    }
  }
  return "";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeOcrTextValue(value) {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeOcrTextValue).filter(Boolean).join(" ").trim();
  }
  if (value && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    for (const key of [
      "text",
      "content",
      "value",
      "rec_text",
      "transcription",
    ]) {
      const text = normalizeOcrTextValue(record[key]);
      if (text) {
        return text;
      }
    }
  }
  return "";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeOcrTextForPrompt(value) {
  return truncateText(
    normalizeOcrTextValue(value)
      .replace(/[\u0000-\u001F\u007F]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    160,
  );
}

/**
 * @param {PromptOptions} [options]
 * @param {ImageVariant[]} [imageVariants]
 * @returns {PromptCoordinateFrame}
 */
function resolvePromptCoordinateFrame(options = {}, imageVariants = []) {
  if (isOpenAICodexProvider(options)) {
    const geometryVariant =
      imageVariants.find((variant) => variant.role === "openai-vision") ||
      imageVariants[0];
    const width =
      readPositiveInteger(geometryVariant?.width) ||
      readPositiveInteger(options.imageWidth) ||
      1000;
    const height =
      readPositiveInteger(geometryVariant?.height) ||
      readPositiveInteger(options.imageHeight) ||
      1000;
    return {
      space: "pixels",
      frame: { width, height },
    };
  }

  return {
    space: "normalized_1000",
    frame: { width: 1000, height: 1000 },
  };
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function readPositiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

module.exports = {
  PROMPT_KO_BBOX_LINES_MULTIVIEW,
  buildSystemPrompt,
  buildWorkContextSection,
  getOverlayPrompt,
  readOcrCandidateText,
  readPositiveInteger,
  resolvePromptCoordinateFrame,
  sanitizeHintLabel,
  sanitizeOcrTextForPrompt,
};
