// @ts-check
/**
 * @typedef {{ x: number; y: number; w: number; h: number }} ParsedBbox
 * @typedef {{ [key: string]: number | undefined; x1?: number; y1?: number; x2?: number; y2?: number }} PartialParsedBbox
 * @typedef {{
 *   id?: number;
 *   type?: string;
 *   textRole?: string;
 *   direction?: "horizontal" | "vertical";
 *   angle?: number;
 *   fontSize?: number | null;
 *   confidence?: number | null;
 *   partialBbox?: PartialParsedBbox;
 *   bbox?: ParsedBbox | null;
 *   jp?: string;
 *   ko?: string;
 * }} LooseParsedItem
 * @typedef {{
 *   id: number;
 *   type: string;
 *   x1?: number;
 *   y1?: number;
 *   x2?: number;
 *   y2?: number;
 *   jp: string;
 *   ko: string;
 *   sourceText?: string;
 *   translatedText?: string;
 *   textRole?: string;
 *   direction?: "horizontal" | "vertical";
 *   angle?: number;
 *   fontSize?: number | null;
 *   confidence?: number | null;
 * }} LooseParsedOutput
 * @typedef {{ requireBbox?: boolean }} LooseParseOptions
 */
// Gemma (and similar) models occasionally emit reserved/special tokens such as
// `<unused49>` straight into their text output. These corrupt the structured
// JSON (breaking parsing or polluting block text), which drops translations.
// Strip them before any parsing.
const SPECIAL_TOKEN_PATTERN =
  /<\/?(?:unused\d+|start_of_turn|end_of_turn|eos|bos|pad|mask|unk)>/gi;

/**
 * @param {string} rawText
 * @returns {string}
 */
function stripModelSpecialTokens(rawText) {
  return rawText.replace(SPECIAL_TOKEN_PATTERN, "");
}

/**
 * @param {string} rawText
 * @returns {string}
 */
function extractJsonCandidate(rawText) {
  const trimmed = rawText.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const firstObject = trimmed.indexOf("{");
  const lastObject = trimmed.lastIndexOf("}");
  if (firstObject !== -1 && lastObject > firstObject) {
    return trimmed.slice(firstObject, lastObject + 1);
  }

  const firstArray = trimmed.indexOf("[");
  const lastArray = trimmed.lastIndexOf("]");
  if (firstArray !== -1 && lastArray > firstArray) {
    return trimmed.slice(firstArray, lastArray + 1);
  }

  throw new Error("Could not find a JSON object in the model output.");
}

/**
 * @param {string} rawText
 * @returns {unknown}
 */
function parseJsonLenient(rawText) {
  const text = stripModelSpecialTokens(rawText);
  let candidate;
  try {
    candidate = extractJsonCandidate(text);
  } catch (error) {
    const looseItems = parseLooseItemList(text);
    if (looseItems.length > 0) {
      return { items: looseItems };
    }
    throw new Error(
      "Failed to find a parseable structured payload in the model output.",
      { cause: error },
    );
  }

  const attempts = [
    candidate,
    candidate.replace(/,\s*([}\]])/g, "$1"),
    repairBrokenJson(candidate),
  ];

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (hasStructuredItems(parsed)) {
        return parsed;
      }
    } catch (_error) {
      // Try the next cleanup step.
    }
  }

  const looseItems = parseLooseItemList(text);
  if (looseItems.length > 0) {
    return { items: looseItems };
  }

  const candidateLooseItems = parseLooseItemList(candidate);
  if (candidateLooseItems.length > 0) {
    return { items: candidateLooseItems };
  }

  throw new Error("Failed to parse model output as JSON.");
}

/**
 * @param {string} rawText
 * @returns {{ item: unknown | null }}
 */
function parseRegionSingleItem(rawText) {
  const text = stripModelSpecialTokens(rawText);
  let candidate;
  try {
    candidate = extractJsonCandidate(text);
  } catch (error) {
    throw new Error(
      "Region response contract violation: JSON object missing.",
      {
        cause: error,
      },
    );
  }

  const attempts = [
    candidate,
    candidate.replace(/,\s*([}\]])/g, "$1"),
    repairBrokenJson(candidate),
  ];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      return validateRegionSingleItemPayload(JSON.parse(attempt));
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    'Region response contract violation: expected { "item": {...} } or { "item": null }.',
    { cause: lastError },
  );
}

/**
 * @param {unknown} parsed
 * @returns {{ item: unknown | null }}
 */
function validateRegionSingleItemPayload(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "Region response contract violation: top-level object required.",
    );
  }
  const record = /** @type {Record<string, unknown>} */ (parsed);
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "item") {
    throw new Error(
      "Region response contract violation: exactly one item key required.",
    );
  }
  if (record.item === null) {
    return { item: null };
  }
  if (
    !record.item ||
    typeof record.item !== "object" ||
    Array.isArray(record.item)
  ) {
    throw new Error(
      "Region response contract violation: item must be an object or null.",
    );
  }
  return { item: record.item };
}

/**
 * @param {unknown} parsed
 * @returns {boolean}
 */
function hasStructuredItems(parsed) {
  const record =
    parsed && typeof parsed === "object"
      ? /** @type {{ items?: unknown; blocks?: unknown }} */ (parsed)
      : {};
  return (
    Array.isArray(parsed) ||
    Array.isArray(record.items) ||
    Array.isArray(record.blocks)
  );
}

/**
 * @param {string} candidate
 * @returns {string}
 */
function repairBrokenJson(candidate) {
  let repaired = candidate.trim();
  repaired = repaired
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
  repaired = repaired.replace(
    /"?(id|type|textRole|text_role|bbox|jp|ko|sourceText|translatedText|source|target|direction|angle|fontSize|confidence|x1|y1|x2|y2)(?::|\s*:)/gi,
    /** @param {string} _ @param {string} key */
    (_, key) => `"${normalizeRepairedJsonKey(key)}":`,
  );
  repaired = repaired.replace(
    /([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g,
    /** @param {string} _ @param {string} prefix @param {string} key */
    (_, prefix, key) => `${prefix}"${key}":`,
  );
  repaired = repaired.replace(/:\s*'([^']*)'/g, ': "$1"');
  repaired = repaired.replace(
    /("id"\s*:\s*)([A-Za-z]+)(\s*[,\n}])/g,
    '$1"$2"$3',
  );
  repaired = repaired.replace(
    /("(?:jp|ko|source|target|sourceText|translatedText|type)"\s*:\s*)([^"{[\n][^,\n}]*)/g,
    /** @param {string} _match @param {string} prefix @param {string} value */
    (_match, prefix, value) => {
      const trimmed = String(value).trim();
      if (!trimmed || /^"/.test(trimmed)) {
        return `${prefix}${trimmed}`;
      }
      return `${prefix}"${trimmed.replace(/^['"]|['"]$/g, "")}"`;
    },
  );
  repaired = repaired.replace(/"(x1|y1|x2|y2)\s*:/g, '"$1":');
  repaired = repaired.replace(/([{\s,])(x1|y1|x2|y2)\s*:/g, '$1"$2":');
  repaired = repaired.replace(/"ko\s*:/g, '"ko":');
  repaired = repaired.replace(/,\s*([}\]])/g, "$1");
  return repaired;
}

/**
 * @param {string} key
 * @returns {string}
 */
function normalizeRepairedJsonKey(key) {
  const lower = key.toLowerCase();
  if (lower === "fontsize") {
    return "fontSize";
  }
  if (lower === "textrole" || lower === "text_role") {
    return "textRole";
  }
  if (lower === "sourcetext") {
    return "sourceText";
  }
  if (lower === "translatedtext") {
    return "translatedText";
  }
  return lower;
}

/**
 * @param {string} line
 * @returns {string}
 */
function normalizeLooseLine(line) {
  return line
    .replace(/"(x1|y1|x2|y2)\s*:/g, '"$1":')
    .replace(/"ko\s*:/g, '"ko":')
    .trim();
}

/**
 * @param {PartialParsedBbox | null | undefined} partialBbox
 * @returns {ParsedBbox | null}
 */
function bboxFromPartial(partialBbox) {
  if (!partialBbox) {
    return null;
  }

  const x1 = Number(partialBbox.x1);
  const y1 = Number(partialBbox.y1);
  const x2 = Number(partialBbox.x2);
  const y2 = Number(partialBbox.y2);
  if (![x1, y1, x2, y2].every(Number.isFinite)) {
    return null;
  }

  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const right = Math.max(x1, x2);
  const bottom = Math.max(y1, y2);
  return {
    x: left,
    y: top,
    w: right - left,
    h: bottom - top,
  };
}

/**
 * @param {string} rawText
 * @param {LooseParseOptions} [options]
 * @returns {LooseParsedOutput[]}
 */
function parseLooseItemList(rawText, options = {}) {
  const requireBbox = options.requireBbox !== false;
  const cleaned = rawText
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
  const lines = expandLooseRecordLines(cleaned);
  /** @type {LooseParsedOutput[]} */
  const items = [];
  /** @type {LooseParsedItem | null} */
  let current = null;
  /** @type {"jp" | "ko" | null} */
  let currentTextKey = null;

  function pushCurrent() {
    if (!current) {
      return;
    }
    if (!current.bbox && current.partialBbox) {
      current.bbox = bboxFromPartial(current.partialBbox);
    }
    if (
      (!requireBbox || current.bbox) &&
      typeof current.ko === "string" &&
      current.ko.trim()
    ) {
      const bboxFields = current.bbox
        ? {
            x1: current.bbox.x,
            y1: current.bbox.y,
            x2: current.bbox.x + current.bbox.w,
            y2: current.bbox.y + current.bbox.h,
          }
        : {};
      items.push({
        id: current.id ?? items.length + 1,
        type: normalizeParsedType(current.type),
        ...bboxFields,
        jp: current.jp || "",
        ko: current.ko.trim(),
        ...(current.textRole ? { textRole: current.textRole } : {}),
        ...(current.direction ? { direction: current.direction } : {}),
        ...(Number.isFinite(current.angle) ? { angle: current.angle } : {}),
        ...(Number.isFinite(current.fontSize)
          ? { fontSize: current.fontSize }
          : {}),
        ...(Number.isFinite(current.confidence)
          ? { confidence: current.confidence }
          : {}),
      });
    }
    current = null;
  }

  for (const rawLine of lines) {
    const line = normalizeLooseLine(rawLine.trim());
    if (!line) {
      pushCurrent();
      currentTextKey = null;
      continue;
    }

    const idMatch = line.match(
      /^(?:\{?\s*)?"?id"?\s*:\s*["']?([A-Za-z0-9_-]+)["']?/i,
    );
    if (idMatch) {
      pushCurrent();
      currentTextKey = null;
      const parsedId = Number(idMatch[1]);
      current = Number.isFinite(parsedId) ? { id: parsedId } : {};
      continue;
    }

    if (!current) {
      current = {};
    }

    const typeMatch = line.match(/^"?type"?\s*:\s*["']?([^"',}]+)["']?/i);
    if (typeMatch) {
      currentTextKey = null;
      current.type = typeMatch[1];
      continue;
    }

    const textRoleMatch = line.match(
      /^"?(?:textRole|text_role|role)"?\s*:\s*["']?([^"',}]+)["']?/i,
    );
    if (textRoleMatch) {
      currentTextKey = null;
      current.textRole = textRoleMatch[1];
      continue;
    }

    const directionMatch = line.match(
      /^"?direction"?\s*:\s*["']?([^"',}]+)["']?/i,
    );
    if (directionMatch) {
      currentTextKey = null;
      current.direction = normalizeDirection(directionMatch[1]);
      continue;
    }

    const angleMatch = line.match(/^"?angle"?\s*:\s*["']?(-?[0-9.]+)["']?/i);
    if (angleMatch) {
      currentTextKey = null;
      current.angle = Number(angleMatch[1]);
      continue;
    }

    const fontSizeMatch = line.match(
      /^"?(?:fontSize|font_size|font)"?\s*:\s*["']?([0-9.]+)["']?/i,
    );
    if (fontSizeMatch) {
      currentTextKey = null;
      current.fontSize = Number(fontSizeMatch[1]);
      continue;
    }

    const confidenceMatch = line.match(
      /^"?confidence"?\s*:\s*["']?([0-9.]+)%?["']?/i,
    );
    if (confidenceMatch) {
      currentTextKey = null;
      current.confidence = Number(confidenceMatch[1]);
      continue;
    }

    const coordMatches = [
      ...line.matchAll(/["']?(x1|y1|x2|y2)["']?\s*:\s*(-?[0-9.]+)/g),
    ];
    if (coordMatches.length > 0) {
      currentTextKey = null;
      current.partialBbox = current.partialBbox || {};
      for (const match of coordMatches) {
        current.partialBbox[match[1]] = Number(match[2]);
      }
      current.bbox = bboxFromPartial(current.partialBbox) || current.bbox;
      continue;
    }

    const jpMatch = line.match(
      /^"?(?:jp|source|sourceText|source_text)"?\s*:\s*["']?(.+?)["']?[,]?$/i,
    );
    if (jpMatch) {
      current.jp = jpMatch[1];
      currentTextKey = "jp";
      continue;
    }

    const koMatch = line.match(
      /^"?(?:ko|target|translatedText|translated_text)"?\s*:\s*["']?(.+?)["']?[,]?$/i,
    );
    if (koMatch) {
      current.ko = koMatch[1];
      currentTextKey = "ko";
      continue;
    }

    if (currentTextKey && current) {
      const continuation = line.replace(/[,]$/, "").trim();
      if (continuation) {
        current[currentTextKey] = current[currentTextKey]
          ? `${current[currentTextKey]}\n${continuation}`
          : continuation;
      }
    }
  }

  pushCurrent();
  return items;
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function expandLooseRecordLines(text) {
  const rawLines = text.split(/\r?\n/);
  /** @type {string[]} */
  const expanded = [];
  const keyPattern =
    /(?:^|\s)(id|type|textRole|text_role|role|direction|angle|fontSize|font_size|font|confidence|x1|y1|x2|y2|jp|ko|sourceText|source_text|source|translatedText|translated_text|target)\s*:/gi;
  for (const rawLine of rawLines) {
    const matches = [...rawLine.matchAll(keyPattern)];
    if (matches.length <= 1) {
      expanded.push(rawLine);
      continue;
    }
    for (let index = 0; index < matches.length; index += 1) {
      const start = matches[index].index ?? 0;
      const end =
        index + 1 < matches.length
          ? (matches[index + 1].index ?? rawLine.length)
          : rawLine.length;
      const segment = rawLine.slice(start, end).trim();
      if (segment) {
        expanded.push(segment);
      }
    }
  }
  return expanded;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {number} value
 * @returns {number}
 */
function roundCoordinate(value) {
  return Math.round(value);
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} [max]
 * @returns {number}
 */
function clampCoordinate(value, min, max = Number.POSITIVE_INFINITY) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

/**
 * @param {ParsedBbox} bbox
 * @returns {ParsedBbox}
 */
function clampBbox(bbox) {
  const x = clampCoordinate(bbox.x, 0);
  const y = clampCoordinate(bbox.y, 0);
  const w = clampCoordinate(bbox.w, 1);
  const h = clampCoordinate(bbox.h, 1);
  return { x, y, w, h };
}

/**
 * @param {unknown} value
 * @returns {"horizontal" | "vertical"}
 */
function normalizeDirection(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  return text === "vertical" ? "vertical" : "horizontal";
}

/**
 * @param {unknown} value
 * @returns {"" | "sound" | "ordinary" | "nontext"}
 */
function normalizeTextRole(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "");
  if (!text) {
    return "";
  }
  if (
    [
      "sound",
      "sfx",
      "soundeffect",
      "effect",
      "reaction",
      "onomatopoeia",
    ].includes(text)
  ) {
    return "sound";
  }
  if (
    [
      "ordinary",
      "speech",
      "dialogue",
      "dialog",
      "bubble",
      "caption",
      "narration",
      "label",
      "sign",
      "note",
      "title",
    ].includes(text)
  ) {
    return "ordinary";
  }
  if (
    [
      "nontext",
      "nottext",
      "reject",
      "decoration",
      "texture",
      "ornament",
    ].includes(text)
  ) {
    return "nontext";
  }
  return "";
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeAngle(value) {
  const parsed = toNumber(value);
  if (parsed === null) {
    return 0;
  }
  return Math.min(30, Math.max(-30, Math.round(parsed)));
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function normalizeFontSize(value) {
  const parsed = toNumber(value);
  if (parsed === null) {
    return null;
  }
  return Math.min(160, Math.max(6, Math.round(parsed)));
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function normalizeConfidence(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = toNumber(value);
  if (parsed === null) {
    return null;
  }
  const normalized = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
  return Math.min(1, Math.max(0, normalized));
}

/**
 * @param {unknown} item
 * @returns {ParsedBbox | null}
 */
function normalizeBBox(item) {
  const box =
    item && typeof item === "object"
      ? /** @type {Record<string, unknown>} */ (item)
      : null;
  if (!box || typeof box !== "object") {
    return null;
  }

  const cornerBbox = bboxFromPartial({
    x1: toNumber(box.x1) ?? undefined,
    y1: toNumber(box.y1) ?? undefined,
    x2: toNumber(box.x2) ?? undefined,
    y2: toNumber(box.y2) ?? undefined,
  });
  const x = toNumber(cornerBbox?.x);
  const y = toNumber(cornerBbox?.y);
  const w = toNumber(cornerBbox?.w);
  const h = toNumber(cornerBbox?.h);

  if (x === null || y === null || w === null || h === null) {
    return null;
  }

  return clampBbox({
    x: roundCoordinate(x),
    y: roundCoordinate(y),
    w: roundCoordinate(w),
    h: roundCoordinate(h),
  });
}

/**
 * @param {unknown} item
 * @param {number} index
 * @returns {(LooseParsedOutput & { bbox: ParsedBbox }) | null}
 */
function normalizeItem(item, index) {
  const record =
    item && typeof item === "object"
      ? /** @type {Record<string, unknown>} */ (item)
      : {};
  const ko = [
    record.ko,
    record.target,
    record.translatedText,
    record.korean,
    record.translation,
    record.translated,
    record.text_ko,
  ].find((value) => typeof value === "string" && value.trim());
  const jp =
    [
      record.jp,
      record.source,
      record.sourceText,
      record.japanese,
      record.ocr,
      record.text_jp,
    ].find((value) => typeof value === "string" && value.trim()) || "";
  const bbox = normalizeBBox(record);
  const normalizedKo = normalizeTextField(ko);
  const normalizedJp = normalizeTextField(jp);

  if (!normalizedKo || !bbox) {
    return null;
  }

  if (
    isPlaceholderOnly(normalizedKo) &&
    (!normalizedJp || isPlaceholderOnly(normalizedJp))
  ) {
    return null;
  }

  return {
    id: toNumber(record.id) ?? index + 1,
    type: normalizeParsedType(record.type),
    ...(normalizeTextRole(record.textRole ?? record.text_role ?? record.role)
      ? {
          textRole: normalizeTextRole(
            record.textRole ?? record.text_role ?? record.role,
          ),
        }
      : {}),
    bbox,
    // jp/ko는 하위 호환 별칭이고 sourceText/translatedText가 중립 명칭이다.
    // 두 쌍 모두 항상 같은 값으로 채워진다.
    jp: normalizedJp,
    ko: normalizedKo,
    sourceText: normalizedJp,
    translatedText: normalizedKo,
    direction: normalizeDirection(
      record.direction ?? record.sourceDirection ?? record.writingDirection,
    ),
    angle: normalizeAngle(
      record.angle ?? record.rotation ?? record.rotationDeg,
    ),
    fontSize: normalizeFontSize(
      record.fontSize ?? record.font_size ?? record.font,
    ),
    confidence: normalizeConfidence(record.confidence ?? record.score),
  };
}

/**
 * @param {unknown} value
 * @returns {"reject" | "nonsolid"}
 */
function normalizeParsedType(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase() === "reject"
    ? "reject"
    : "nonsolid";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeTextField(value) {
  return String(value ?? "")
    .replace(/\\n/g, "\n")
    .trim();
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlaceholderOnly(value) {
  const compact = String(value ?? "").replace(/\s+/g, "");
  return compact === "[?]" || compact === "？" || compact === "?";
}

/**
 * @param {unknown} parsed
 * @returns {Array<LooseParsedOutput & { bbox: ParsedBbox }>}
 */
function normalizeItems(parsed) {
  const record =
    parsed && typeof parsed === "object"
      ? /** @type {{ items?: unknown; blocks?: unknown }} */ (parsed)
      : {};
  const items = /** @type {unknown[]} */ (
    Array.isArray(parsed)
      ? parsed
      : Array.isArray(record.items)
        ? record.items
        : Array.isArray(record.blocks)
          ? record.blocks
          : []
  );

  return items
    .map((item, index) => normalizeItem(item, index))
    .filter((item) => item !== null);
}

/**
 * @param {unknown} parsed
 * @returns {Array<LooseParsedOutput & { bbox: ParsedBbox }>}
 */
function normalizeRegionSingleItem(parsed) {
  const payload = validateRegionSingleItemPayload(parsed);
  if (payload.item === null) {
    return [];
  }
  const itemRecord = /** @type {Record<string, unknown>} */ (payload.item);
  const normalized = normalizeItem(
    {
      ...itemRecord,
      id: 1,
      type: itemRecord.type || "nonsolid",
      textRole: itemRecord.textRole || itemRecord.text_role || "ordinary",
    },
    0,
  );
  if (!normalized) {
    throw new Error(
      "Region response contract violation: item object is incomplete.",
    );
  }
  return [
    {
      ...normalized,
      id: 1,
      type: "nonsolid",
      textRole: normalized.textRole || "ordinary",
    },
  ];
}

module.exports = {
  extractJsonCandidate,
  normalizeItems,
  normalizeRegionSingleItem,
  parseJsonLenient,
  parseRegionSingleItem,
  repairBrokenJson,
  stripModelSpecialTokens,
};
