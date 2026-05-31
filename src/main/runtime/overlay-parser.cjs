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

function parseJsonLenient(rawText) {
  let candidate = "";
  try {
    candidate = extractJsonCandidate(rawText);
  } catch {
    const looseItems = parseLooseItemList(rawText);
    if (looseItems.length > 0) {
      return { items: looseItems };
    }
    throw new Error("Failed to find a parseable structured payload in the model output.");
  }

  const attempts = [
    candidate,
    candidate.replace(/,\s*([}\]])/g, "$1"),
    repairBrokenJson(candidate)
  ];

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (hasStructuredItems(parsed)) {
        return parsed;
      }
    } catch {
      // Try the next cleanup step.
    }
  }

  const looseItems = parseLooseItemList(rawText);
  if (looseItems.length > 0) {
    return { items: looseItems };
  }

  const candidateLooseItems = parseLooseItemList(candidate);
  if (candidateLooseItems.length > 0) {
    return { items: candidateLooseItems };
  }

  throw new Error("Failed to parse model output as JSON.");
}

function hasStructuredItems(parsed) {
  return Array.isArray(parsed) || Array.isArray(parsed?.items) || Array.isArray(parsed?.blocks);
}

function repairBrokenJson(candidate) {
  let repaired = candidate.trim();
  repaired = repaired.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  repaired = repaired.replace(/"?(id|type|textRole|text_role|bbox|jp|ko|direction|angle|fontSize|confidence|x1|y1|x2|y2)(?::|\s*:)/gi, (_, key) => `"${key === "fontSize" ? "fontSize" : key === "textRole" || key === "text_role" ? "textRole" : key.toLowerCase()}":`);
  repaired = repaired.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, (_, prefix, key) => `${prefix}"${key}":`);
  repaired = repaired.replace(/:\s*'([^']*)'/g, ': "$1"');
  repaired = repaired.replace(/("id"\s*:\s*)([A-Za-z]+)(\s*[,\n}])/g, '$1"$2"$3');
  repaired = repaired.replace(/("(?:jp|ko|type)"\s*:\s*)([^"{\[\n][^,\n}]*)/g, (_match, prefix, value) => {
    const trimmed = String(value).trim();
    if (!trimmed || /^"/.test(trimmed)) {
      return `${prefix}${trimmed}`;
    }
    return `${prefix}"${trimmed.replace(/^['"]|['"]$/g, "")}"`;
  });
  repaired = repaired.replace(/"(x1|y1|x2|y2)\s*:/g, "\"$1\":");
  repaired = repaired.replace(/([{\s,])(x1|y1|x2|y2)\s*:/g, "$1\"$2\":");
  repaired = repaired.replace(/"ko\s*:/g, "\"ko\":");
  repaired = repaired.replace(/,\s*([}\]])/g, "$1");
  return repaired;
}

function normalizeLooseLine(line) {
  return line
    .replace(/"(x1|y1|x2|y2)\s*:/g, "\"$1\":")
    .replace(/"ko\s*:/g, "\"ko\":")
    .trim();
}

function bboxFromPartial(partialBbox) {
  if (!partialBbox) {
    return null;
  }

  if (!["x1", "y1", "x2", "y2"].every((key) => Number.isFinite(partialBbox[key]))) {
    return null;
  }

  const left = Math.min(partialBbox.x1, partialBbox.x2);
  const top = Math.min(partialBbox.y1, partialBbox.y2);
  const right = Math.max(partialBbox.x1, partialBbox.x2);
  const bottom = Math.max(partialBbox.y1, partialBbox.y2);
  return {
    x: left,
    y: top,
    w: right - left,
    h: bottom - top
  };
}

function parseLooseItemList(rawText, options = {}) {
  const requireBbox = options.requireBbox !== false;
  const cleaned = rawText
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
  const lines = cleaned.split(/\r?\n/);
  const items = [];
  let current = null;
  let currentTextKey = null;

  function pushCurrent() {
    if (!current) {
      return;
    }
    if (!current.bbox && current.partialBbox) {
      current.bbox = bboxFromPartial(current.partialBbox);
    }
    if ((!requireBbox || current.bbox) && typeof current.ko === "string" && current.ko.trim()) {
      const bboxFields = current.bbox
        ? {
            x1: current.bbox.x,
            y1: current.bbox.y,
            x2: current.bbox.x + current.bbox.w,
            y2: current.bbox.y + current.bbox.h
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
        ...(Number.isFinite(current.fontSize) ? { fontSize: current.fontSize } : {}),
        ...(Number.isFinite(current.confidence) ? { confidence: current.confidence } : {})
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

    const idMatch = line.match(/^(?:\{?\s*)?"?id"?\s*:\s*["']?([A-Za-z0-9_-]+)["']?/i);
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

    const textRoleMatch = line.match(/^"?(?:textRole|text_role|role)"?\s*:\s*["']?([^"',}]+)["']?/i);
    if (textRoleMatch) {
      currentTextKey = null;
      current.textRole = textRoleMatch[1];
      continue;
    }

    const directionMatch = line.match(/^"?direction"?\s*:\s*["']?([^"',}]+)["']?/i);
    if (directionMatch) {
      currentTextKey = null;
      current.direction = directionMatch[1];
      continue;
    }

    const angleMatch = line.match(/^"?angle"?\s*:\s*["']?(-?[0-9.]+)["']?/i);
    if (angleMatch) {
      currentTextKey = null;
      current.angle = Number(angleMatch[1]);
      continue;
    }

    const fontSizeMatch = line.match(/^"?(?:fontSize|font_size|font)"?\s*:\s*["']?([0-9.]+)["']?/i);
    if (fontSizeMatch) {
      currentTextKey = null;
      current.fontSize = Number(fontSizeMatch[1]);
      continue;
    }

    const confidenceMatch = line.match(/^"?confidence"?\s*:\s*["']?([0-9.]+)%?["']?/i);
    if (confidenceMatch) {
      currentTextKey = null;
      current.confidence = Number(confidenceMatch[1]);
      continue;
    }

    const coordMatches = [...line.matchAll(/["']?(x1|y1|x2|y2)["']?\s*:\s*(-?[0-9.]+)/g)];
    if (coordMatches.length > 0) {
      currentTextKey = null;
      current.partialBbox = current.partialBbox || {};
      for (const match of coordMatches) {
        current.partialBbox[match[1]] = Number(match[2]);
      }
      current.bbox = bboxFromPartial(current.partialBbox) || current.bbox;
      continue;
    }

    const jpMatch = line.match(/^"?jp"?\s*:\s*["']?(.+?)["']?[,]?$/i);
    if (jpMatch) {
      current.jp = jpMatch[1];
      currentTextKey = "jp";
      continue;
    }

    const koMatch = line.match(/^"?ko"?\s*:\s*["']?(.+?)["']?[,]?$/i);
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

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundCoordinate(value) {
  return Math.round(value);
}

function clampCoordinate(value, min, max = Number.POSITIVE_INFINITY) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function clampBbox(bbox) {
  const x = clampCoordinate(bbox.x, 0);
  const y = clampCoordinate(bbox.y, 0);
  const w = clampCoordinate(bbox.w, 1);
  const h = clampCoordinate(bbox.h, 1);
  return { x, y, w, h };
}

function normalizeDirection(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "vertical" ? "vertical" : "horizontal";
}

function normalizeAngle(value) {
  const parsed = toNumber(value);
  if (parsed === null) {
    return 0;
  }
  return Math.min(30, Math.max(-30, Math.round(parsed)));
}

function normalizeFontSize(value) {
  const parsed = toNumber(value);
  if (parsed === null) {
    return null;
  }
  return Math.min(160, Math.max(6, Math.round(parsed)));
}

function normalizeConfidence(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = toNumber(value);
  if (parsed === null) {
    return null;
  }
  const normalized = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
  return Math.min(1, Math.max(0, Math.round(normalized * 100) / 100));
}

function normalizeBBox(item) {
  const box = item;
  if (!box || typeof box !== "object") {
    return null;
  }

  const cornerBbox = bboxFromPartial({
    x1: toNumber(box.x1),
    y1: toNumber(box.y1),
    x2: toNumber(box.x2),
    y2: toNumber(box.y2)
  });
  const x = toNumber(cornerBbox?.x);
  const y = toNumber(cornerBbox?.y);
  const w = toNumber(cornerBbox?.w);
  const h = toNumber(cornerBbox?.h);

  if (![x, y, w, h].every((value) => value !== null)) {
    return null;
  }

  return clampBbox({
    x: roundCoordinate(x),
    y: roundCoordinate(y),
    w: roundCoordinate(w),
    h: roundCoordinate(h)
  });
}

function normalizePixelBBox(item) {
  const box = item;
  if (!box || typeof box !== "object") {
    return null;
  }

  const cornerBbox = bboxFromPartial({
    x1: toNumber(box.x1),
    y1: toNumber(box.y1),
    x2: toNumber(box.x2),
    y2: toNumber(box.y2)
  });
  const x = toNumber(cornerBbox?.x);
  const y = toNumber(cornerBbox?.y);
  const w = toNumber(cornerBbox?.w);
  const h = toNumber(cornerBbox?.h);

  if (![x, y, w, h].every((value) => value !== null)) {
    return null;
  }

  return {
    x: Math.max(0, roundCoordinate(x)),
    y: Math.max(0, roundCoordinate(y)),
    w: Math.max(1, roundCoordinate(w)),
    h: Math.max(1, roundCoordinate(h))
  };
}

function normalizeItem(item, index) {
  const ko = [item?.ko, item?.korean, item?.translation, item?.translated, item?.text_ko].find((value) => typeof value === "string" && value.trim());
  const jp = [item?.jp, item?.japanese, item?.source, item?.ocr, item?.text_jp].find((value) => typeof value === "string" && value.trim()) || "";
  const bbox = normalizeBBox(item);
  const normalizedKo = normalizeTextField(ko);
  const normalizedJp = normalizeTextField(jp);

  if (!normalizedKo || !bbox) {
    return null;
  }

  if (isPlaceholderOnly(normalizedKo) && (!normalizedJp || isPlaceholderOnly(normalizedJp))) {
    return null;
  }

  return {
    id: toNumber(item?.id) ?? index + 1,
    type: normalizeParsedType(item?.type),
    bbox,
    jp: normalizedJp,
    ko: normalizedKo,
    direction: normalizeDirection(item?.direction ?? item?.sourceDirection ?? item?.writingDirection),
    angle: normalizeAngle(item?.angle ?? item?.rotation ?? item?.rotationDeg),
    fontSize: normalizeFontSize(item?.fontSize ?? item?.font_size ?? item?.font),
    confidence: normalizeConfidence(item?.confidence ?? item?.score)
  };
}

function normalizeRetryItem(item, index) {
  const ko = [item?.ko, item?.korean, item?.translation, item?.translated, item?.text_ko].find((value) => typeof value === "string" && value.trim());
  const jp = [item?.jp, item?.japanese, item?.source, item?.ocr, item?.text_jp].find((value) => typeof value === "string" && value.trim()) || "";
  const normalizedKo = normalizeTextField(ko);
  const normalizedJp = normalizeTextField(jp);
  const bbox = normalizePixelBBox(item);

  if (!normalizedKo) {
    return null;
  }

  return {
    id: toNumber(item?.id) ?? index + 1,
    type: normalizeParsedType(item?.type),
    ...(bbox ? { bbox } : {}),
    ...(typeof item?.textRole === "string" && item.textRole.trim() ? { textRole: item.textRole.trim() } : {}),
    jp: normalizedJp,
    ko: normalizedKo,
    direction: normalizeDirection(item?.direction ?? item?.sourceDirection ?? item?.writingDirection),
    angle: normalizeAngle(item?.angle ?? item?.rotation ?? item?.rotationDeg),
    fontSize: normalizeFontSize(item?.fontSize ?? item?.font_size ?? item?.font),
    confidence: normalizeConfidence(item?.confidence ?? item?.score)
  };
}

function normalizeParsedType(value) {
  return String(value ?? "").trim().toLowerCase() === "reject" ? "reject" : "nonsolid";
}

function normalizeTextField(value) {
  return String(value ?? "")
    .replace(/\\n/g, "\n")
    .trim();
}

function isPlaceholderOnly(value) {
  const compact = String(value ?? "").replace(/\s+/g, "");
  return compact === "[?]" || compact === "？" || compact === "?";
}

function normalizeItems(parsed) {
  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.items)
      ? parsed.items
      : Array.isArray(parsed?.blocks)
        ? parsed.blocks
        : [];

  return items
    .map((item, index) => normalizeItem(item, index))
    .filter(Boolean);
}

function normalizeRetryItems(parsed) {
  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.items)
      ? parsed.items
      : Array.isArray(parsed?.blocks)
        ? parsed.blocks
        : [];

  return items
    .map((item, index) => normalizeRetryItem(item, index))
    .filter(Boolean);
}

function parseRetryItems(rawText) {
  const looseItems = normalizeRetryItems({ items: parseLooseItemList(rawText, { requireBbox: false }) });
  try {
    const parsedItems = normalizeRetryItems(parseJsonLenient(rawText));
    return looseItems.length > parsedItems.length ? looseItems : parsedItems;
  } catch {
    return looseItems;
  }
}

module.exports = {
  extractJsonCandidate,
  normalizeItems,
  normalizeRetryItems,
  parseRetryItems,
  parseJsonLenient,
  repairBrokenJson
};
