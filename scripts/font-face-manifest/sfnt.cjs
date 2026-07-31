const NAME_FIELDS = new Map([
  [0, "copyright"],
  [1, "family"],
  [2, "subfamily"],
  [3, "unique_id"],
  [4, "full_name"],
  [5, "version"],
  [6, "postscript_name"],
  [13, "license_description"],
  [14, "license_url"],
  [16, "typographic_family"],
  [17, "typographic_subfamily"],
]);

/** @typedef {{ offset: number; length: number }} SfntTable */
/** @typedef {{ start: number; end: number }} UnicodeRange */

/**
 * @param {Buffer} buffer
 */
function inspectSfnt(buffer) {
  const tables = readTableDirectory(buffer);
  const ranges = readUnicodeRanges(buffer, requireTable(tables, "cmap"));

  return {
    sfnt_signature:
      buffer.toString("latin1", 0, 4) === "OTTO" ? "OTTO" : "00010000",
    names: readNames(buffer, tables.get("name")),
    units_per_em: readOptionalU16(buffer, tables.get("head"), 18),
    glyph_count: readOptionalU16(buffer, tables.get("maxp"), 4),
    os2: readOs2Metadata(buffer, tables.get("OS/2")),
    head: readHeadMetadata(buffer, tables.get("head")),
    post: readPostMetadata(buffer, tables.get("post")),
    variation_axes: readVariationAxes(buffer, tables.get("fvar")),
    vertical: readVerticalMetadata(buffer, tables),
    unicode_ranges: ranges,
  };
}

/** @param {Buffer} buffer @param {SfntTable | undefined} table */
function readOs2Metadata(buffer, table) {
  const selection = readOptionalU16(buffer, table, 62);
  return {
    weight_class: readOptionalU16(buffer, table, 4),
    width_class: readOptionalU16(buffer, table, 6),
    embedding_fs_type: readOptionalU16(buffer, table, 8),
    selection_bits: selection,
    italic: Boolean((selection ?? 0) & 0x01),
    bold: Boolean((selection ?? 0) & 0x20),
    panose:
      table && table.length >= 42
        ? [...buffer.subarray(table.offset + 32, table.offset + 42)]
        : null,
  };
}

/** @param {Buffer} buffer @param {SfntTable | undefined} table */
function readHeadMetadata(buffer, table) {
  const macStyle = readOptionalU16(buffer, table, 44);
  return {
    mac_style_bits: macStyle,
    italic: Boolean((macStyle ?? 0) & 0x02),
    bold: Boolean((macStyle ?? 0) & 0x01),
  };
}

/** @param {Buffer} buffer @param {SfntTable | undefined} table */
function readPostMetadata(buffer, table) {
  return {
    italic_angle:
      table && table.length >= 8 ? readFixed(buffer, table.offset + 4) : null,
  };
}

/** @param {Buffer} buffer @param {Map<string, SfntTable>} tables */
function readVerticalMetadata(buffer, tables) {
  const gsubFeatures = readLayoutFeatures(buffer, tables.get("GSUB"));
  const gposFeatures = readLayoutFeatures(buffer, tables.get("GPOS"));
  return {
    has_vhea: tables.has("vhea"),
    has_vmtx: tables.has("vmtx"),
    gsub_features: gsubFeatures,
    gpos_features: gposFeatures,
    has_vertical_substitution:
      gsubFeatures.includes("vert") || gsubFeatures.includes("vrt2"),
    has_vertical_kerning: gposFeatures.includes("vkrn"),
  };
}

/** @param {Buffer} buffer */
function readTableDirectory(buffer) {
  requireBytes(buffer, 0, 12);
  const tableCount = readU16(buffer, 4);
  if (tableCount < 1 || tableCount > 4096) {
    throw new Error("Invalid SFNT table count.");
  }
  requireBytes(buffer, 12, tableCount * 16);
  /** @type {Map<string, SfntTable>} */
  const tables = new Map();
  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + index * 16;
    const tag = buffer.toString("latin1", record, record + 4);
    const offset = readU32(buffer, record + 8);
    const length = readU32(buffer, record + 12);
    requireBytes(buffer, offset, length);
    if (!tables.has(tag)) tables.set(tag, { offset, length });
  }
  return tables;
}

/** @param {Buffer} buffer @param {SfntTable | undefined} table */
function readNames(buffer, table) {
  /** @type {Record<string, string | null>} */
  const output = {};
  for (const field of NAME_FIELDS.values()) output[field] = null;
  if (!table || table.length < 6) return output;

  const count = readU16(buffer, table.offset + 2);
  const storageOffset = readU16(buffer, table.offset + 4);
  requireTableBytes(buffer, table, 6, count * 12);
  /** @type {Map<number, { value: string; rank: number }>} */
  const selected = new Map();
  for (let index = 0; index < count; index += 1) {
    const record = table.offset + 6 + index * 12;
    const platform = readU16(buffer, record);
    const language = readU16(buffer, record + 4);
    const nameId = readU16(buffer, record + 6);
    if (!NAME_FIELDS.has(nameId)) continue;
    const length = readU16(buffer, record + 8);
    const offset = readU16(buffer, record + 10);
    requireTableBytes(buffer, table, storageOffset + offset, length);
    const value = decodeName(
      buffer.subarray(
        table.offset + storageOffset + offset,
        table.offset + storageOffset + offset + length,
      ),
      platform,
    );
    if (!value) continue;
    const rank = nameRank(platform, language);
    if ((selected.get(nameId)?.rank ?? -1) < rank)
      selected.set(nameId, { value, rank });
  }
  for (const [nameId, selection] of selected) {
    const field = NAME_FIELDS.get(nameId);
    if (field) output[field] = selection.value;
  }
  return output;
}

/** @param {Buffer} bytes @param {number} platform */
function decodeName(bytes, platform) {
  let value = "";
  if (platform === 0 || platform === 3) {
    for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
      value += String.fromCharCode(readU16(bytes, offset));
    }
  } else {
    value = bytes.toString("latin1");
  }
  return value.replace(/\0/g, "").replace(/\s+/g, " ").trim();
}

/** @param {number} platform @param {number} language */
function nameRank(platform, language) {
  if (platform === 3 && language === 0x0409) return 6;
  if (platform === 3 && language === 0x0412) return 5;
  if (platform === 0) return 4;
  if (platform === 3) return 3;
  if (platform === 1 && language === 0) return 2;
  return 1;
}

/** @param {Buffer} buffer @param {SfntTable} cmap */
function readUnicodeRanges(buffer, cmap) {
  requireTableBytes(buffer, cmap, 0, 4);
  const count = readU16(buffer, cmap.offset + 2);
  requireTableBytes(buffer, cmap, 4, count * 8);
  /** @type {UnicodeRange[]} */
  const ranges = [];
  const seen = new Set();
  for (let index = 0; index < count; index += 1) {
    const record = cmap.offset + 4 + index * 8;
    const platform = readU16(buffer, record);
    const encoding = readU16(buffer, record + 2);
    if (
      platform !== 0 &&
      !(platform === 3 && (encoding === 1 || encoding === 10))
    ) {
      continue;
    }
    const relativeOffset = readU32(buffer, record + 4);
    if (seen.has(relativeOffset)) continue;
    seen.add(relativeOffset);
    requireTableBytes(buffer, cmap, relativeOffset, 2);
    const offset = cmap.offset + relativeOffset;
    const format = readU16(buffer, offset);
    if (format === 4) ranges.push(...readFormat4(buffer, cmap, offset));
    if (format === 12 || format === 13) {
      ranges.push(...readFormat12(buffer, cmap, offset, format));
    }
  }
  return mergeRanges(ranges);
}

/** @param {Buffer} buffer @param {SfntTable} cmap @param {number} offset */
function readFormat4(buffer, cmap, offset) {
  requireTableBytes(buffer, cmap, offset - cmap.offset, 14);
  const length = readU16(buffer, offset + 2);
  requireTableBytes(buffer, cmap, offset - cmap.offset, length);
  const segmentCount = readU16(buffer, offset + 6) / 2;
  if (
    !Number.isInteger(segmentCount) ||
    segmentCount < 1 ||
    segmentCount > 0x8000
  ) {
    throw new Error("Invalid cmap format 4 segment count.");
  }
  const endCodes = offset + 14;
  const startCodes = endCodes + segmentCount * 2 + 2;
  const deltas = startCodes + segmentCount * 2;
  const rangeOffsets = deltas + segmentCount * 2;
  requireBytes(buffer, rangeOffsets, segmentCount * 2);
  /** @type {UnicodeRange[]} */
  const output = [];
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const start = readU16(buffer, startCodes + segment * 2);
    const end = readU16(buffer, endCodes + segment * 2);
    if (start > end || start === 0xffff) continue;
    const delta = buffer.readInt16BE(deltas + segment * 2);
    const rangePosition = rangeOffsets + segment * 2;
    const rangeOffset = readU16(buffer, rangePosition);
    appendMappedFormat4Range(
      buffer,
      output,
      start,
      end,
      delta,
      rangePosition,
      rangeOffset,
      offset + length,
    );
  }
  return output;
}

/**
 * @param {Buffer} buffer @param {UnicodeRange[]} output
 * @param {number} start @param {number} end @param {number} delta
 * @param {number} rangePosition @param {number} rangeOffset @param {number} limit
 */
function appendMappedFormat4Range(
  buffer,
  output,
  start,
  end,
  delta,
  rangePosition,
  rangeOffset,
  limit,
) {
  let runStart = -1;
  for (let codePoint = start; codePoint <= end; codePoint += 1) {
    const glyph = readFormat4Glyph(
      buffer,
      codePoint,
      start,
      delta,
      rangePosition,
      rangeOffset,
      limit,
    );
    if (glyph !== 0 && runStart < 0) runStart = codePoint;
    if (glyph === 0 && runStart >= 0) {
      output.push({ start: runStart, end: codePoint - 1 });
      runStart = -1;
    }
  }
  if (runStart >= 0) output.push({ start: runStart, end });
}

/**
 * @param {Buffer} buffer @param {number} codePoint @param {number} start
 * @param {number} delta @param {number} rangePosition
 * @param {number} rangeOffset @param {number} limit
 */
function readFormat4Glyph(
  buffer,
  codePoint,
  start,
  delta,
  rangePosition,
  rangeOffset,
  limit,
) {
  if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
  const glyphOffset = rangePosition + rangeOffset + (codePoint - start) * 2;
  if (glyphOffset + 2 > limit) {
    throw new Error("cmap format 4 glyph is out of bounds.");
  }
  const glyph = readU16(buffer, glyphOffset);
  return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
}

/**
 * @param {Buffer} buffer @param {SfntTable} cmap @param {number} offset
 * @param {number} format
 */
function readFormat12(buffer, cmap, offset, format) {
  requireTableBytes(buffer, cmap, offset - cmap.offset, 16);
  const length = readU32(buffer, offset + 4);
  requireTableBytes(buffer, cmap, offset - cmap.offset, length);
  const count = readU32(buffer, offset + 12);
  if (count > 250000 || 16 + count * 12 > length) {
    throw new Error("Invalid cmap format 12/13 group count.");
  }
  /** @type {UnicodeRange[]} */
  const output = [];
  for (let index = 0; index < count; index += 1) {
    const record = offset + 16 + index * 12;
    let start = readU32(buffer, record);
    const end = readU32(buffer, record + 4);
    const glyph = readU32(buffer, record + 8);
    if (start > end || end > 0x10ffff || (format === 13 && glyph === 0))
      continue;
    if (format === 12 && glyph === 0) start += 1;
    if (start <= end) output.push({ start, end });
  }
  return output;
}

/** @param {UnicodeRange[]} ranges */
function mergeRanges(ranges) {
  const sorted = [...ranges].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  /** @type {UnicodeRange[]} */
  const output = [];
  for (const range of sorted) {
    const previous = output.at(-1);
    if (previous && range.start <= previous.end + 1)
      previous.end = Math.max(previous.end, range.end);
    else output.push({ ...range });
  }
  return output;
}

/** @param {Buffer} buffer @param {SfntTable | undefined} table */
function readVariationAxes(buffer, table) {
  if (!table || table.length < 16) return [];
  const axesOffset = readU16(buffer, table.offset + 4);
  const axisCount = readU16(buffer, table.offset + 8);
  const axisSize = readU16(buffer, table.offset + 10);
  if (axisSize < 20) throw new Error("Invalid fvar axis record size.");
  requireTableBytes(buffer, table, axesOffset, axisCount * axisSize);
  const axes = [];
  for (let index = 0; index < axisCount; index += 1) {
    const record = table.offset + axesOffset + index * axisSize;
    axes.push({
      tag: buffer.toString("latin1", record, record + 4),
      min: readFixed(buffer, record + 4),
      default: readFixed(buffer, record + 8),
      max: readFixed(buffer, record + 12),
    });
  }
  return axes;
}

/** @param {Buffer} buffer @param {SfntTable | undefined} table */
function readLayoutFeatures(buffer, table) {
  if (!table || table.length < 10) return [];
  const featureListOffset = readU16(buffer, table.offset + 6);
  requireTableBytes(buffer, table, featureListOffset, 2);
  const count = readU16(buffer, table.offset + featureListOffset);
  requireTableBytes(buffer, table, featureListOffset + 2, count * 6);
  const tags = new Set();
  for (let index = 0; index < count; index += 1) {
    const offset = table.offset + featureListOffset + 2 + index * 6;
    tags.add(buffer.toString("latin1", offset, offset + 4));
  }
  return [...tags].sort();
}

/** @param {Map<string, SfntTable>} tables @param {string} tag */
function requireTable(tables, tag) {
  const table = tables.get(tag);
  if (!table) throw new Error(`Font is missing ${tag}.`);
  return table;
}

/** @param {Buffer} buffer @param {SfntTable} table @param {number} relativeOffset @param {number} length */
function requireTableBytes(buffer, table, relativeOffset, length) {
  if (
    relativeOffset < 0 ||
    length < 0 ||
    relativeOffset + length > table.length
  ) {
    throw new Error("SFNT table read is out of bounds.");
  }
  requireBytes(buffer, table.offset + relativeOffset, length);
}

/** @param {Buffer} buffer @param {number} offset @param {number} length */
function requireBytes(buffer, offset, length) {
  if (
    !Number.isInteger(offset) ||
    !Number.isInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buffer.length
  ) {
    throw new Error("Font data is truncated.");
  }
}

/** @param {Buffer} buffer @param {number} offset */
function readU16(buffer, offset) {
  requireBytes(buffer, offset, 2);
  return buffer.readUInt16BE(offset);
}

/** @param {Buffer} buffer @param {number} offset */
function readU32(buffer, offset) {
  requireBytes(buffer, offset, 4);
  return buffer.readUInt32BE(offset);
}

/** @param {Buffer} buffer @param {number} offset */
function readFixed(buffer, offset) {
  requireBytes(buffer, offset, 4);
  return buffer.readInt32BE(offset) / 65536;
}

/**
 * @param {Buffer} buffer @param {SfntTable | undefined} table
 * @param {number} relativeOffset
 */
function readOptionalU16(buffer, table, relativeOffset) {
  if (!table || table.length < relativeOffset + 2) return null;
  return readU16(buffer, table.offset + relativeOffset);
}

module.exports = { inspectSfnt };
