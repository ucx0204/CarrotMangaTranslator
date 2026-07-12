// @ts-check
/**
 * @typedef {{ x: number; y: number; w: number; h: number }} ParsedBbox
 * @typedef {{ [key: string]: number | undefined; x1?: number; y1?: number; x2?: number; y2?: number }} PartialParsedBbox
 * @typedef {{ id?: number; type?: string; textRole?: string; direction?: "horizontal" | "vertical"; angle?: number; fontSize?: number | null; confidence?: number | null; partialBbox?: PartialParsedBbox; bbox?: ParsedBbox | null; jp?: string; ko?: string }} LooseParsedItem
 * @typedef {{ id: number; type: string; x1?: number; y1?: number; x2?: number; y2?: number; jp: string; ko: string; textRole?: string; direction?: "horizontal" | "vertical"; angle?: number; fontSize?: number | null; confidence?: number | null }} LooseParsedOutput
 * @typedef {{ requireBbox?: boolean }} LooseParseOptions
 * @typedef {{ items: LooseParsedOutput[]; current: LooseParsedItem | null; currentTextKey: "jp" | "ko" | null; requireBbox: boolean }} LooseParserState
 * @typedef {{ pattern: RegExp; apply: (item: LooseParsedItem, value: string) => void }} ScalarFieldHandler
 * @typedef {{ pattern: RegExp; key: "jp" | "ko" }} TextFieldHandler
 */

const { bboxFromPartial } = require("./overlay-geometry.cjs");
const {
  normalizeDirection,
  normalizeParsedType,
} = require("./overlay-values.cjs");

/** @type {ScalarFieldHandler[]} */
const SCALAR_FIELD_HANDLERS = [
  {
    pattern: /^"?type"?\s*:\s*["']?([^"',}]+)["']?/i,
    apply: (item, value) => {
      item.type = value;
    },
  },
  {
    pattern: /^"?(?:textRole|text_role|role)"?\s*:\s*["']?([^"',}]+)["']?/i,
    apply: (item, value) => {
      item.textRole = value;
    },
  },
  {
    pattern: /^"?direction"?\s*:\s*["']?([^"',}]+)["']?/i,
    apply: (item, value) => {
      item.direction = normalizeDirection(value);
    },
  },
  {
    pattern: /^"?angle"?\s*:\s*["']?(-?[0-9.]+)["']?/i,
    apply: (item, value) => {
      item.angle = Number(value);
    },
  },
  {
    pattern: /^"?(?:fontSize|font_size|font)"?\s*:\s*["']?([0-9.]+)["']?/i,
    apply: (item, value) => {
      item.fontSize = Number(value);
    },
  },
  {
    pattern: /^"?confidence"?\s*:\s*["']?([0-9.]+)%?["']?/i,
    apply: (item, value) => {
      item.confidence = Number(value);
    },
  },
];

/** @type {TextFieldHandler[]} */
const TEXT_FIELD_HANDLERS = [
  {
    pattern:
      /^"?(?:jp|source|sourceText|source_text)"?\s*:\s*["']?(.+?)["']?[,]?$/i,
    key: "jp",
  },
  {
    pattern:
      /^"?(?:ko|target|translatedText|translated_text)"?\s*:\s*["']?(.+?)["']?[,]?$/i,
    key: "ko",
  },
];

/**
 * @param {string} rawText
 * @param {LooseParseOptions} [options]
 * @returns {LooseParsedOutput[]}
 */
function parseLooseItemList(rawText, options = {}) {
  const state = createParserState(options.requireBbox !== false);
  const lines = expandLooseRecordLines(cleanLooseText(rawText));
  for (const rawLine of lines) {
    processLooseLine(state, normalizeLooseLine(rawLine.trim()));
  }
  flushCurrentItem(state);
  return state.items;
}

/** @param {boolean} requireBbox @returns {LooseParserState} */
function createParserState(requireBbox) {
  return { items: [], current: null, currentTextKey: null, requireBbox };
}

/** @param {string} rawText */
function cleanLooseText(rawText) {
  return rawText
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
}

/** @param {string} line */
function normalizeLooseLine(line) {
  return line
    .replace(/"(x1|y1|x2|y2)\s*:/g, '"$1":')
    .replace(/"ko\s*:/g, '"ko":')
    .trim();
}

/** @param {LooseParserState} state @param {string} line */
function processLooseLine(state, line) {
  if (!line) {
    flushCurrentItem(state);
    state.currentTextKey = null;
    return;
  }
  if (startItemFromIdentifier(state, line)) {
    return;
  }
  const current = ensureCurrentItem(state);
  if (applyScalarField(state, current, line)) {
    return;
  }
  if (applyCoordinates(state, current, line)) {
    return;
  }
  if (applyTextField(state, current, line)) {
    return;
  }
  appendTextContinuation(state, current, line);
}

/** @param {LooseParserState} state @param {string} line */
function startItemFromIdentifier(state, line) {
  const match = line.match(
    /^(?:\{?\s*)?"?id"?\s*:\s*["']?([A-Za-z0-9_-]+)["']?/i,
  );
  if (!match) {
    return false;
  }
  flushCurrentItem(state);
  state.currentTextKey = null;
  const id = Number(match[1]);
  state.current = Number.isFinite(id) ? { id } : {};
  return true;
}

/** @param {LooseParserState} state */
function ensureCurrentItem(state) {
  state.current ??= {};
  return state.current;
}

/**
 * @param {LooseParserState} state
 * @param {LooseParsedItem} current
 * @param {string} line
 */
function applyScalarField(state, current, line) {
  for (const handler of SCALAR_FIELD_HANDLERS) {
    const match = line.match(handler.pattern);
    if (match) {
      state.currentTextKey = null;
      handler.apply(current, match[1]);
      return true;
    }
  }
  return false;
}

/**
 * @param {LooseParserState} state
 * @param {LooseParsedItem} current
 * @param {string} line
 */
function applyCoordinates(state, current, line) {
  const matches = [
    ...line.matchAll(/["']?(x1|y1|x2|y2)["']?\s*:\s*(-?[0-9.]+)/g),
  ];
  if (matches.length === 0) {
    return false;
  }
  state.currentTextKey = null;
  current.partialBbox ??= {};
  for (const match of matches) {
    current.partialBbox[match[1]] = Number(match[2]);
  }
  current.bbox = bboxFromPartial(current.partialBbox) || current.bbox;
  return true;
}

/**
 * @param {LooseParserState} state
 * @param {LooseParsedItem} current
 * @param {string} line
 */
function applyTextField(state, current, line) {
  for (const handler of TEXT_FIELD_HANDLERS) {
    const match = line.match(handler.pattern);
    if (match) {
      current[handler.key] = match[1];
      state.currentTextKey = handler.key;
      return true;
    }
  }
  return false;
}

/**
 * @param {LooseParserState} state
 * @param {LooseParsedItem} current
 * @param {string} line
 */
function appendTextContinuation(state, current, line) {
  if (!state.currentTextKey) {
    return;
  }
  const continuation = line.replace(/[,]$/, "").trim();
  if (!continuation) {
    return;
  }
  const key = state.currentTextKey;
  current[key] = current[key]
    ? `${current[key]}\n${continuation}`
    : continuation;
}

/** @param {LooseParserState} state */
function flushCurrentItem(state) {
  if (!state.current) {
    return;
  }
  const output = finalizeLooseItem(
    state.current,
    state.items.length,
    state.requireBbox,
  );
  if (output) {
    state.items.push(output);
  }
  state.current = null;
}

/**
 * @param {LooseParsedItem} current
 * @param {number} index
 * @param {boolean} requireBbox
 * @returns {LooseParsedOutput | null}
 */
function finalizeLooseItem(current, index, requireBbox) {
  current.bbox ||= bboxFromPartial(current.partialBbox);
  if (requireBbox && !current.bbox) {
    return null;
  }
  if (typeof current.ko !== "string" || !current.ko.trim()) {
    return null;
  }
  const output = createLooseOutput(current, index);
  addOptionalLooseFields(output, current);
  return output;
}

/** @param {LooseParsedItem} current @param {number} index */
function createLooseOutput(current, index) {
  const bboxFields = current.bbox
    ? {
        x1: current.bbox.x,
        y1: current.bbox.y,
        x2: current.bbox.x + current.bbox.w,
        y2: current.bbox.y + current.bbox.h,
      }
    : {};
  return {
    id: current.id ?? index + 1,
    type: normalizeParsedType(current.type),
    ...bboxFields,
    jp: current.jp || "",
    ko: current.ko?.trim() || "",
  };
}

/** @param {LooseParsedOutput} output @param {LooseParsedItem} current */
function addOptionalLooseFields(output, current) {
  if (current.textRole) {
    output.textRole = current.textRole;
  }
  if (current.direction) {
    output.direction = current.direction;
  }
  addFiniteField(output, "angle", current.angle);
  addFiniteField(output, "fontSize", current.fontSize);
  addFiniteField(output, "confidence", current.confidence);
}

/**
 * @param {LooseParsedOutput} output
 * @param {"angle" | "fontSize" | "confidence"} key
 * @param {number | null | undefined} value
 */
function addFiniteField(output, key, value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    output[key] = value;
  }
}

/** @param {string} text @returns {string[]} */
function expandLooseRecordLines(text) {
  const rawLines = text.split(/\r?\n/);
  /** @type {string[]} */
  const expanded = [];
  const keyPattern =
    /(?:^|\s)(id|type|textRole|text_role|role|direction|angle|fontSize|font_size|font|confidence|x1|y1|x2|y2|jp|ko|sourceText|source_text|source|translatedText|translated_text|target)\s*:/gi;
  for (const rawLine of rawLines) {
    expandLooseRecordLine(rawLine, keyPattern, expanded);
  }
  return expanded;
}

/** @param {string} line @param {RegExp} pattern @param {string[]} output */
function expandLooseRecordLine(line, pattern, output) {
  const matches = [...line.matchAll(pattern)];
  if (matches.length <= 1) {
    output.push(line);
    return;
  }
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index ?? 0;
    const end = matches[index + 1]?.index ?? line.length;
    const segment = line.slice(start, end).trim();
    if (segment) {
      output.push(segment);
    }
  }
}

module.exports = {
  parseLooseItemList,
};
