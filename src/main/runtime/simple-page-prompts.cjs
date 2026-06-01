function truncateText(value, maxLength) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}... [truncated ${text.length - maxLength} chars]`;
}

function isOpenAICodexProvider(options = {}) {
  return String(options.modelProvider ?? "").trim() === "openai-codex";
}

const OVERLAY_OUTPUT_SCHEMA = [
  "id: <integer>",
  "type: nonsolid",
  "x1: <integer>",
  "y1: <integer>",
  "x2: <integer>",
  "y2: <integer>",
  "direction: <horizontal|vertical>",
  "angle: <integer>",
  "fontSize: <integer>",
  "confidence: <0.00-1.00>",
  "jp: <visible Japanese source text>",
  "ko: <concise Korean translation>"
].join("\n");

const OVERLAY_PROMPT_SECTIONS = [
  [
    "Task",
    "You are given the same Japanese manga page in multiple full-page renderings.",
    "Image 1 is the coordinate-authority full page. Assist images are only for reading the same page.",
    "Detect every visible Japanese text group and translate it into concise Korean.",
    "Scan the entire page before writing records; do not stop after the first obvious text.",
    "First identify the exact Japanese glyph strokes for each item, then write the record. Do not estimate from the speech bubble or panel shape.",
    "Before reading dialogue text, segment the visible speech balloons themselves. Each distinct balloon lobe and each separated dialogue text cluster becomes a separate dialogue record.",
    "Only output real Japanese text. Do not output decorative line art, background marks, panel ornaments, texture, or unreadable marks as text."
  ],
  [
    "Output",
    "Return plain text records only. Do not output JSON, markdown, bullets, commentary, or code fences.",
    "Use exactly these keys, one per line: id, type, x1, y1, x2, y2, direction, angle, fontSize, confidence, jp, ko.",
    "Do not copy placeholder text. Estimate every value from the actual glyphs in Image 1.",
    "confidence is your confidence from 0.00 to 1.00 that the item is real Japanese text, correctly read, correctly typed, and correctly translated.",
    "Use confidence below 0.72 when the crop is hard to read, partly clipped, possibly decorative, or the translation may be uncertain.",
    "If jp has multiple visible source lines, put every readable source line in jp. Continuation lines after jp: belong to jp until the ko: key.",
    "Write ko as natural Korean for horizontal reading. Do not mirror Japanese vertical line breaks; use commas or short Korean phrases unless a real list or dialogue pause needs a line break.",
    "If the entire jp or ko would be only [?], skip that record instead of outputting an unreadable placeholder.",
    "Skip records whose jp is only punctuation, decorative marks, page numbers, a lone Latin letter, or a clipped one-character fragment. Do not output such scraps as standalone records.",
    "If a stylized SFX looks like a Latin letter but is probably Japanese kana, re-read it as kana. If you still cannot read it as Japanese, skip it rather than translating the Latin letter.",
    "Put one blank line between records.",
    "Record template:",
    OVERLAY_OUTPUT_SCHEMA
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
    "angle is the visible glyph slant in degrees from -30 to 30. Use 0 for upright text.",
    "Before final output, mentally fill each bbox with translucent color: no Japanese glyph from jp should remain visible outside that filled area.",
    "Then check tightness: if the filled area covers large blank bubble paper or caption-box padding on any side, redraw the bbox tighter around the glyph ink.",
    "Then check placement: the center of the bbox must lie on or very near the jp glyph ink cluster, not on adjacent background art or empty panel space.",
    "Decorative hearts, bubble tails, panel borders, box borders, background textures, and motion effects are not Japanese glyph ink."
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
    "Do not invent SFX from vertical panel trim, furniture lines, wall patterns, or isolated non-character strokes.",
    "Do not add records for isolated symbol fragments, stray decorative marks, page numbers, or clipped scraps that are not complete Japanese text.",
    "Include meaningful short interjections, names, captions, and SFX."
  ],
  [
    "Rendering hints",
    "type must always be nonsolid. The app uses one Flux-based inpainting path for every text block, including speech bubbles, captions, labels, handwriting, and SFX.",
    "For sound-effect or reaction lettering, ko must be bare Korean effect lettering only: no parentheses, brackets, quotes, stage directions, action descriptions, or explanatory notes.",
    "For sound-effect or reaction lettering, translate the visual sound/reaction text itself, not the character's motion or the scene description.",
    "First decide whether the source is ordinary language or printed sound/reaction lettering. Ordinary language can be translated as Korean text; printed sound/reaction lettering must stay as sound lettering.",
    "SFX translation priority: preserve the original visible sound texture first. The default is short Korean phonetic rendering of the Japanese sound. Use a localized Korean onomatopoeia only when it keeps the same consonant/vowel texture and visual feel.",
    "Do not force every SFX into semantic Korean. If a Japanese SFX is stylized, iconic, or has no clean Korean equivalent, keep the source sound feel in Korean pronunciation instead of inventing an action verb.",
    "Do not translate ambient SFX as spoken dialogue. Treat it as printed sound/reaction lettering unless the visible text is clearly an actual spoken line.",
    "For motion, impact, cutting, texture, and ambient SFX, infer the sound class from image context and lettering shape. If the scene is unclear, keep the sound texture instead of choosing an unrelated meaning.",
    "For repeated or lengthened SFX, preserve the visible rhythm and duration in compact Korean instead of collapsing it into a generic word.",
    "For printed sound/reaction lettering, ko should be readable aloud as a sound printed on the page. It must not be an adverbial phrase, narration, action description, emotion description, or sentence.",
    "For printed sound/reaction lettering, avoid Korean grammar endings, particles, connective endings, and explanatory spacing. Prefer one compact sound string over a phrase.",
    "If the source lettering includes a grammatical connector after a sound, translate only the sound value unless the entire visible source is ordinary language.",
    "Do not translate a single SFX by describing the surrounding action, emotion, or speaker. The overlay text should read like a sound printed on the page.",
    "Do not output isolated fragments as separate records. Skip punctuation, decorative marks, digits, page numbers, lone Latin letters, isolated small kana/sokuon, or clipped single-character scraps unless they are clearly a complete visible text item.",
    "Prefer dropping a doubtful decorative or fragmentary mark over producing a confident but meaningless translation.",
    "Do not translate partial SFX strokes or decorative fragments as dictionary words. Attach incomplete strokes to their neighboring glyphs or skip them if they are not a complete readable item.",
    "Keep SFX ko very short, usually one compact sound phrase. Avoid explaining who moved, what happened, or why.",
    "Use angle 0 for ordinary upright speech and captions; use a nonzero angle only when the source glyphs are visibly slanted.",
    "Keep Korean short enough for an on-image overlay while preserving meaning.",
    "For handwritten diagrams and search-word lists, translate the whole note as one compact Korean phrase or comma-separated list when possible.",
    "If OCR is uncertain, write [?] only for the uncertain fragment and still output the item."
  ]
];

const PROMPT_KO_BBOX_LINES_MULTIVIEW = buildOverlayPrompt();

function buildSystemPrompt(options = {}) {
  const lines = [
    "You are an OCR and manga-translation engine.",
    "Return only the machine-readable record format requested by the user prompt.",
    "Geometry accuracy comes before Korean text fit: preserve the original Japanese glyph position and apparent size.",
    "Never merge separate speech bubbles, including touching or stacked balloon lobes.",
    "For SFX records, output bare Korean effect lettering only; do not wrap it in parentheses/brackets/quotes or turn it into a stage direction.",
    "For SFX records, preserve the original visible sound texture first: default to short Korean phonetic rendering. Use localized Korean onomatopoeia only when it keeps the same consonant/vowel texture. Do not force ambient sounds into dialogue words or action descriptions."
  ];

  if (options.regionCropMode) {
    lines.push(
      "Selected-region mode: group by visual text container, not by line or column. One speech bubble or one caption plate is one item even when the Japanese is split across multiple vertical columns or lines."
    );
  }

  return lines.join("\n\n");
}

function buildOverlayPrompt(options = {}, imageVariants = []) {
  const sections = OVERLAY_PROMPT_SECTIONS.map(([title, ...lines]) => [title, ...lines]);
  sections[0] = buildTaskSection(options, imageVariants);
  const regionCropSection = buildRegionCropSection(options);
  if (regionCropSection.length > 1) {
    sections.splice(1, 0, regionCropSection);
  }
  const coordinateSection = buildCoordinateCalibrationSection(options, imageVariants);
  if (coordinateSection.length > 1) {
    sections.splice(2, 0, coordinateSection);
  }
  const ocrHintSection = buildOcrBboxHintSection(options, imageVariants);
  if (ocrHintSection.length > 1) {
    const coordinateIndex = sections.findIndex((section) => section[0] === "Coordinate calibration");
    sections.splice(coordinateIndex === -1 ? 2 : coordinateIndex + 1, 0, ocrHintSection);
  }

  return sections
    .map(([title, ...lines]) => [`# ${title}`, ...lines].join("\n"))
    .join("\n\n");
}

function getOverlayPrompt(options = {}, imageVariants = []) {
  return buildOverlayPrompt(options, imageVariants);
}

function buildTaskSection(options = {}, imageVariants = []) {
  const hasAssistImages = imageVariants.length > 1;
  const regionCropMode = Boolean(options.regionCropMode);
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
    "Scan the entire page before writing records; do not stop after the first obvious text.",
    "First identify the exact Japanese glyph strokes for each item, then write the record. Do not estimate from the speech bubble or panel shape.",
    "Before reading dialogue text, segment the visible speech balloons themselves. Each distinct balloon lobe and each separated dialogue text cluster becomes a separate dialogue record.",
    "Only output real Japanese text. Do not output decorative line art, background marks, panel ornaments, texture, or unreadable marks as text."
  ];
}

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
    "The bbox for that one record should tightly cover the union of all visible Japanese glyph ink belonging to the same bubble/caption, not the whole bubble paper."
  ];
}

function buildCoordinateCalibrationSection(options = {}, imageVariants = []) {
  const originalWidth = readPositiveInteger(options.imageWidth);
  const originalHeight = readPositiveInteger(options.imageHeight);
  const geometryVariant = imageVariants.find((variant) => variant.role === "openai-vision") || imageVariants[0];
  const sentWidth = readPositiveInteger(geometryVariant?.width);
  const sentHeight = readPositiveInteger(geometryVariant?.height);
  const coordinateFrame = resolvePromptCoordinateFrame(options, imageVariants);
  if (!originalWidth || !originalHeight) {
    return [];
  }

  const lines = ["Coordinate calibration", `The original page is ${originalWidth}x${originalHeight} px.`];

  if (coordinateFrame.space === "pixels") {
    lines.push(
      `Image 1 was prepared before the API call to match the OpenAI detail: original vision frame, so the model sees Image 1 as ${coordinateFrame.frame.width}x${coordinateFrame.frame.height} px.`,
      `Return x1, y1, x2, y2 as integer pixel coordinates in that ${coordinateFrame.frame.width}x${coordinateFrame.frame.height} Image 1 frame.`,
      "Do not return width/height, original-page pixels, normalized 0..1000 coordinates, viewport coordinates, crop coordinates, tile coordinates, or model-internal coordinates.",
      `Use the full visible Image 1 frame as the coordinate frame: left edge 0, top edge 0, right edge ${coordinateFrame.frame.width}, bottom edge ${coordinateFrame.frame.height}.`,
      "The app will map these sent-image pixels back to the original page after the model response."
    );
    return lines;
  }

  lines.push(
    "Return x1, y1, x2, y2 as normalized 0..1000 corner coordinates over Image 1, not viewport, crop, tile, or model-internal coordinates.",
    "Use the full visible Image 1 frame as the coordinate frame: left edge 0, top edge 0, right edge 1000, bottom edge 1000.",
    "Because Image 1 preserves the original aspect ratio, these normalized coordinates map directly back to the original page."
  );

  if (sentWidth && sentHeight && (sentWidth !== originalWidth || sentHeight !== originalHeight)) {
    lines.push(
      `For OpenAI vision, Image 1 was pre-scaled to ${sentWidth}x${sentHeight} px for detail: original before sending so the coordinate frame matches what the model sees.`,
      `If measuring in sent pixels, convert directly with x1 = round(left * 1000 / ${sentWidth}), y1 = round(top * 1000 / ${sentHeight}), x2 = round(right * 1000 / ${sentWidth}), y2 = round(bottom * 1000 / ${sentHeight}).`
    );
  }

  return lines;
}

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
    .map((hint, index) => formatOcrBboxHintForPrompt(hint, index + 1, frame, originalWidth, originalHeight))
    .filter(Boolean);
  const candidateIds = hints
    .slice(0, formattedHints.length)
    .map((hint, index) => readPositiveInteger(hint.id) || index + 1);
  const maxCandidateId = Math.max(...candidateIds, 0);

  if (formattedHints.length === 0) {
    return [];
  }

  return [
    "OCR bbox candidates",
    "An external OCR geometry detector has already proposed bbox candidates. Some candidates include low-trust OCR text hints for slot matching only.",
    "OCR text hints may be wrong, incomplete, or split strangely. Use Image 1 as the authority for the actual Japanese text and Korean translation.",
    "Use the OCR text hint to keep each translated record attached to the correct candidate id, especially when nearby candidates are close together.",
    "Treat each candidate as a locked geometry slot. For every candidate that contains Japanese glyphs, output one record with that same id and the exact x1, y1, x2, y2 numbers shown below.",
    `Required candidate ids: ${candidateIds.join(", ")}.`,
    "Read and translate only the text inside that candidate rectangle plus a tiny visual margin; do not move the rectangle to a different nearby text group.",
    "For each candidate, read every visible Japanese line inside the rectangle. A candidate record is incomplete if jp or ko contains only the first line while lower or side lines remain readable.",
    "If a candidate is a handwritten note or diagram label, preserve all readable words, but translate ko compactly for horizontal Korean reading rather than copying the Japanese vertical line breaks.",
    "For every accepted candidate, output type nonsolid.",
    "You may change a candidate bbox only when Image 1 clearly proves the candidate clips visible glyph strokes or includes non-text art; then change the minimum amount needed.",
    "Do not merge two candidates into one record, even when the sentence continues across them. Candidate rectangles are separate output records.",
    "If two candidates are stacked or touching speech bubbles, output two separate dialogue records with their original ids.",
    "OCR candidates are a floor, not a ceiling. After processing candidates, inspect the whole Image 1 again for missing Japanese text.",
    `If the detector missed visible Japanese text, add a new record with id greater than ${maxCandidateId}. Never reuse a candidate id for missing text outside that candidate rectangle.`,
    "New records are allowed only for clear Japanese glyphs that are not covered by any candidate.",
    "For new missing SFX records, search especially near character bodies, panel edges, and lower panels where OCR often misses gray or outlined kana. The bbox must visibly cover kana/SFX glyph strokes.",
    "Never add SFX on panel trim, furniture lines, wall patterns, or isolated vertical strokes.",
    "The candidate coordinates below are already converted into the same coordinate frame required for your output.",
    "",
    ...formattedHints
  ];
}

function formatOcrBboxHintForPrompt(hint, fallbackId, frame, originalWidth, originalHeight) {
  const x1 = Number(hint?.x1);
  const y1 = Number(hint?.y1);
  const x2 = Number(hint?.x2);
  const y2 = Number(hint?.y2);
  if (![x1, y1, x2, y2].every(Number.isFinite)) {
    return "";
  }

  const id = readPositiveInteger(hint.id) || fallbackId;
  const label = sanitizeHintLabel(hint.label);
  const converted = convertOriginalPixelBoxToPromptFrame({ x1, y1, x2, y2 }, frame, originalWidth, originalHeight);
  const score = Number.isFinite(hint.score) ? ` score:${Math.round(hint.score * 100) / 100}` : "";
  const ocrText = sanitizeOcrTextForPrompt(readOcrCandidateText(hint));
  const textHint = ocrText ? ` ocrText:${JSON.stringify(ocrText)}` : "";
  return `candidate ${id}: label:${label} x1:${converted.x1} y1:${converted.y1} x2:${converted.x2} y2:${converted.y2}${score}${textHint}`;
}

function convertOriginalPixelBoxToPromptFrame(box, frame, originalWidth, originalHeight) {
  if (frame.space === "pixels" && originalWidth && originalHeight) {
    const xScale = frame.frame.width / originalWidth;
    const yScale = frame.frame.height / originalHeight;
    return {
      x1: Math.round(Math.min(box.x1, box.x2) * xScale),
      y1: Math.round(Math.min(box.y1, box.y2) * yScale),
      x2: Math.round(Math.max(box.x1, box.x2) * xScale),
      y2: Math.round(Math.max(box.y1, box.y2) * yScale)
    };
  }

  if (originalWidth && originalHeight) {
    return {
      x1: Math.round((Math.min(box.x1, box.x2) / originalWidth) * 1000),
      y1: Math.round((Math.min(box.y1, box.y2) / originalHeight) * 1000),
      x2: Math.round((Math.max(box.x1, box.x2) / originalWidth) * 1000),
      y2: Math.round((Math.max(box.y1, box.y2) / originalHeight) * 1000)
    };
  }

  return {
    x1: Math.round(Math.min(box.x1, box.x2)),
    y1: Math.round(Math.min(box.y1, box.y2)),
    x2: Math.round(Math.max(box.x1, box.x2)),
    y2: Math.round(Math.max(box.y1, box.y2))
  };
}

function sanitizeHintLabel(value) {
  const text = String(value ?? "text").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  return text || "text";
}

function readOcrCandidateText(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return "";
  }
  for (const key of ["ocrText", "ocr_text", "text", "content", "block_content", "rec_text", "transcription"]) {
    const text = normalizeOcrTextValue(candidate[key]);
    if (text) {
      return text;
    }
  }
  return "";
}

function normalizeOcrTextValue(value) {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeOcrTextValue).filter(Boolean).join(" ").trim();
  }
  if (value && typeof value === "object") {
    for (const key of ["text", "content", "value", "rec_text", "transcription"]) {
      const text = normalizeOcrTextValue(value[key]);
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function sanitizeOcrTextForPrompt(value) {
  return truncateText(normalizeOcrTextValue(value).replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim(), 160);
}

function resolvePromptCoordinateFrame(options = {}, imageVariants = []) {
  if (isOpenAICodexProvider(options)) {
    const geometryVariant = imageVariants.find((variant) => variant.role === "openai-vision") || imageVariants[0];
    const width = readPositiveInteger(geometryVariant?.width) || readPositiveInteger(options.imageWidth) || 1000;
    const height = readPositiveInteger(geometryVariant?.height) || readPositiveInteger(options.imageHeight) || 1000;
    return {
      space: "pixels",
      frame: { width, height }
    };
  }

  return {
    space: "normalized_1000",
    frame: { width: 1000, height: 1000 }
  };
}

function readPositiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

module.exports = {
  PROMPT_KO_BBOX_LINES_MULTIVIEW,
  buildSystemPrompt,
  getOverlayPrompt,
  readOcrCandidateText,
  readPositiveInteger,
  resolvePromptCoordinateFrame,
  sanitizeHintLabel,
  sanitizeOcrTextForPrompt
};
