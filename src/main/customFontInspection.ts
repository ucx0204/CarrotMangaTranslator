import type {
  AutomaticFontUnicodeRange,
  AutomaticFontCandidate,
} from "../shared/fontMatchingTypes";
import type { UiLocale } from "../shared/uiLocales";
import { rangesContainCodePoint } from "./fontCoverage";

type SfntTable = {
  offset: number;
  length: number;
};

const EMPTY_SFNT_TABLE: SfntTable = { offset: 0, length: 0 };

export type CustomFontInspection = Pick<
  AutomaticFontCandidate,
  "italic" | "serif" | "supportedLocales" | "unicodeRanges" | "weight" | "width"
>;

const LOCALE_PROBES: Readonly<Record<UiLocale, readonly number[]>> = {
  ko: [0xac00, 0xb098, 0xd55c],
  en: [0x41, 0x61, 0x30],
  ja: [0x3042, 0x30a2, 0x65e5],
  "zh-Hans": [0x4e2d, 0x56fd],
  "zh-Hant": [0x4e2d, 0x570b],
};

const MAX_FORMAT_4_GLYPH_READS = 1_200_000;
const MAX_CMAP_GROUPS = 250_000;
const MAX_CMAP_RECORDS = 4096;
const MAX_CMAP_RANGES = 250_000;

type CmapWorkBudget = {
  format4GlyphReads: number;
  groups: number;
  ranges: number;
};

export function inspectCustomFontBuffer(buffer: Buffer): CustomFontInspection {
  const tables = readSfntTables(buffer);
  const unicodeRanges = readUnicodeRanges(buffer, requireTable(tables, "cmap"));
  if (unicodeRanges.length === 0) {
    throw new Error("Font has no usable Unicode cmap.");
  }
  const os2 = tables.get("OS/2");
  const head = tables.get("head");
  const metrics = readFontMetrics(buffer, os2, head);
  return {
    ...metrics,
    supportedLocales: resolveSupportedLocales(unicodeRanges),
    unicodeRanges,
  };
}

function readSfntTables(buffer: Buffer): Map<string, SfntTable> {
  requireBytes(buffer, 0, 12);
  const numTables = buffer.readUInt16BE(4);
  if (numTables <= 0 || numTables > 4096) {
    throw new Error("Font table directory is invalid.");
  }
  requireBytes(buffer, 12, numTables * 16);
  const tables = new Map<string, SfntTable>();
  for (let index = 0; index < numTables; index += 1) {
    const recordOffset = 12 + index * 16;
    const tag = buffer.toString("latin1", recordOffset, recordOffset + 4);
    const offset = buffer.readUInt32BE(recordOffset + 8);
    const length = buffer.readUInt32BE(recordOffset + 12);
    requireBytes(buffer, offset, length);
    if (!tables.has(tag)) {
      tables.set(tag, { offset, length });
    }
  }
  return tables;
}

function requireTable(tables: Map<string, SfntTable>, tag: string): SfntTable {
  const table = tables.get(tag);
  if (!table) {
    throw new Error(`Font is missing the ${tag} table.`);
  }
  return table;
}

function readUnicodeRanges(
  buffer: Buffer,
  cmap: SfntTable,
): AutomaticFontUnicodeRange[] {
  requireTableBytes(buffer, cmap, 0, 4);
  const numTables = buffer.readUInt16BE(cmap.offset + 2);
  if (numTables > MAX_CMAP_RECORDS) {
    throw new Error("Font cmap record count is invalid.");
  }
  requireTableBytes(buffer, cmap, 4, numTables * 8);
  const collected: Array<[number, number]> = [];
  const visitedSubtables = new Set<number>();
  const budget: CmapWorkBudget = {
    format4GlyphReads: 0,
    groups: 0,
    ranges: 0,
  };
  for (let index = 0; index < numTables; index += 1) {
    const recordOffset = cmap.offset + 4 + index * 8;
    const platformId = buffer.readUInt16BE(recordOffset);
    const encodingId = buffer.readUInt16BE(recordOffset + 2);
    if (!isUnicodeCmap(platformId, encodingId)) {
      continue;
    }
    const subtableRelativeOffset = buffer.readUInt32BE(recordOffset + 4);
    if (visitedSubtables.has(subtableRelativeOffset)) {
      continue;
    }
    visitedSubtables.add(subtableRelativeOffset);
    const subtableOffset = cmap.offset + subtableRelativeOffset;
    requireTableBytes(buffer, cmap, subtableRelativeOffset, 2);
    const format = buffer.readUInt16BE(subtableOffset);
    let ranges: Array<[number, number]> = [];
    if (format === 4) {
      ranges = readFormat4Ranges(buffer, cmap, subtableOffset, budget);
    } else if (format === 12 || format === 13) {
      ranges = readFormat12Or13Ranges(
        buffer,
        cmap,
        subtableOffset,
        format,
        budget,
      );
    }
    budget.ranges += ranges.length;
    if (budget.ranges > MAX_CMAP_RANGES) {
      throw new Error("Font cmap contains too many ranges.");
    }
    for (const range of ranges) {
      collected.push(range);
    }
  }
  return mergeUnicodeRanges(collected);
}

function isUnicodeCmap(platformId: number, encodingId: number): boolean {
  return (
    platformId === 0 ||
    (platformId === 3 && (encodingId === 1 || encodingId === 10))
  );
}

function readFormat4Ranges(
  buffer: Buffer,
  cmap: SfntTable,
  subtableOffset: number,
  budget: CmapWorkBudget,
): Array<[number, number]> {
  requireTableBytes(buffer, cmap, subtableOffset - cmap.offset, 14);
  const length = buffer.readUInt16BE(subtableOffset + 2);
  requireCmapSubtable(cmap, subtableOffset, length, 14);
  const segCount = buffer.readUInt16BE(subtableOffset + 6) / 2;
  if (!Number.isInteger(segCount) || segCount <= 0 || segCount > 0x8000) {
    throw new Error("Font cmap format 4 segment count is invalid.");
  }
  const endCodesOffset = subtableOffset + 14;
  const startCodesOffset = endCodesOffset + segCount * 2 + 2;
  const idDeltasOffset = startCodesOffset + segCount * 2;
  const idRangeOffsetsOffset = idDeltasOffset + segCount * 2;
  requireSubtableBytes(
    buffer,
    subtableOffset,
    length,
    0,
    idRangeOffsetsOffset + segCount * 2 - subtableOffset,
  );
  const ranges: Array<[number, number]> = [];
  for (let segment = 0; segment < segCount; segment += 1) {
    const start = buffer.readUInt16BE(startCodesOffset + segment * 2);
    const end = buffer.readUInt16BE(endCodesOffset + segment * 2);
    if (isInvalidFormat4Segment(start, end)) {
      continue;
    }
    const delta = buffer.readInt16BE(idDeltasOffset + segment * 2);
    const rangeOffsetPosition = idRangeOffsetsOffset + segment * 2;
    const rangeOffset = buffer.readUInt16BE(rangeOffsetPosition);
    if (rangeOffset === 0) {
      pushRangeExcept(ranges, start, end, -delta & 0xffff);
      continue;
    }
    budget.format4GlyphReads += end - start + 1;
    if (budget.format4GlyphReads > MAX_FORMAT_4_GLYPH_READS) {
      throw new Error("Font cmap format 4 requires too many glyph reads.");
    }
    for (let codePoint = start; codePoint <= end; codePoint += 1) {
      const glyphOffset =
        rangeOffsetPosition + rangeOffset + (codePoint - start) * 2;
      if (glyphOffset + 2 > subtableOffset + length) {
        continue;
      }
      const rawGlyphId = buffer.readUInt16BE(glyphOffset);
      const glyphId = rawGlyphId === 0 ? 0 : (rawGlyphId + delta) & 0xffff;
      if (glyphId !== 0) {
        ranges.push([codePoint, codePoint]);
      }
    }
  }
  return ranges;
}

function readFormat12Or13Ranges(
  buffer: Buffer,
  cmap: SfntTable,
  subtableOffset: number,
  format: 12 | 13,
  budget: CmapWorkBudget,
): Array<[number, number]> {
  requireTableBytes(buffer, cmap, subtableOffset - cmap.offset, 16);
  const length = buffer.readUInt32BE(subtableOffset + 4);
  requireCmapSubtable(cmap, subtableOffset, length, 16);
  const groupCount = buffer.readUInt32BE(subtableOffset + 12);
  budget.groups += groupCount;
  if (budget.groups > MAX_CMAP_GROUPS) {
    throw new Error("Font cmap group count is invalid.");
  }
  requireSubtableBytes(buffer, subtableOffset, length, 16, groupCount * 12);
  const ranges: Array<[number, number]> = [];
  for (let group = 0; group < groupCount; group += 1) {
    const offset = subtableOffset + 16 + group * 12;
    let start = buffer.readUInt32BE(offset);
    const end = buffer.readUInt32BE(offset + 4);
    const startGlyphId = buffer.readUInt32BE(offset + 8);
    if (start > end || start > 0x10ffff) {
      continue;
    }
    if (format === 13 && startGlyphId === 0) {
      continue;
    }
    if (format === 12 && startGlyphId === 0) {
      start += 1;
    }
    if (start <= end) {
      ranges.push([start, Math.min(end, 0x10ffff)]);
    }
  }
  return ranges;
}

function readFontMetrics(
  buffer: Buffer,
  os2: SfntTable | undefined,
  head: SfntTable | undefined,
): Pick<CustomFontInspection, "italic" | "serif" | "weight" | "width"> {
  const os2Table = optionalTable(os2);
  const headTable = optionalTable(head);
  let weight = 400;
  let width = 5;
  let italic = false;
  let serif: boolean | undefined;
  if (os2Table.length >= 8) {
    weight = clampMetric(
      buffer.readUInt16BE(os2Table.offset + 4),
      1,
      1000,
      400,
    );
    width = clampMetric(buffer.readUInt16BE(os2Table.offset + 6), 1, 9, 5);
  }
  if (os2Table.length >= 42) {
    const familyType = buffer[os2Table.offset + 32];
    const serifStyle = buffer[os2Table.offset + 33];
    serif =
      familyType !== 2 || serifStyle < 2 || serifStyle > 15
        ? undefined
        : serifStyle <= 10;
  }
  if (os2Table.length >= 64) {
    italic = (buffer.readUInt16BE(os2Table.offset + 62) & 0x01) !== 0;
  }
  if (headTable.length >= 46) {
    italic ||= (buffer.readUInt16BE(headTable.offset + 44) & 0x02) !== 0;
  }
  return { italic, serif, weight, width };
}

function optionalTable(table: SfntTable | undefined): SfntTable {
  return table ?? EMPTY_SFNT_TABLE;
}

function resolveSupportedLocales(
  ranges: readonly AutomaticFontUnicodeRange[],
): UiLocale[] {
  return (Object.entries(LOCALE_PROBES) as Array<[UiLocale, readonly number[]]>)
    .filter(([, probes]) =>
      probes.every((codePoint) => rangesContainCodePoint(ranges, codePoint)),
    )
    .map(([locale]) => locale);
}

function mergeUnicodeRanges(
  ranges: Array<[number, number]>,
): AutomaticFontUnicodeRange[] {
  const sorted = [...ranges].sort(
    (left, right) => left[0] - right[0] || left[1] - right[1],
  );
  const merged: Array<[number, number]> = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1] + 1) {
      previous[1] = Math.max(previous[1], range[1]);
    } else {
      merged.push([...range]);
    }
  }
  return merged;
}

function pushRangeExcept(
  ranges: Array<[number, number]>,
  start: number,
  end: number,
  excluded: number,
): void {
  if (excluded < start || excluded > end) {
    ranges.push([start, end]);
    return;
  }
  if (start < excluded) {
    ranges.push([start, excluded - 1]);
  }
  if (excluded < end) {
    ranges.push([excluded + 1, end]);
  }
}

function isInvalidFormat4Segment(start: number, end: number): boolean {
  return start > end || start === 0xffff;
}

function clampMetric(
  value: number,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function requireCmapSubtable(
  cmap: SfntTable,
  subtableOffset: number,
  length: number,
  minimumLength: number,
): void {
  if (
    !Number.isInteger(length) ||
    length < minimumLength ||
    subtableOffset < cmap.offset ||
    subtableOffset + length > cmap.offset + cmap.length
  ) {
    throw new Error("Font cmap subtable is out of bounds.");
  }
}

function requireSubtableBytes(
  buffer: Buffer,
  subtableOffset: number,
  subtableLength: number,
  relativeOffset: number,
  length: number,
): void {
  if (
    relativeOffset < 0 ||
    length < 0 ||
    relativeOffset + length > subtableLength
  ) {
    throw new Error("Font cmap subtable read is out of bounds.");
  }
  requireBytes(buffer, subtableOffset + relativeOffset, length);
}

function requireTableBytes(
  buffer: Buffer,
  table: SfntTable,
  relativeOffset: number,
  length: number,
): void {
  if (
    relativeOffset < 0 ||
    length < 0 ||
    relativeOffset + length > table.length
  ) {
    throw new Error("Font table read is out of bounds.");
  }
  requireBytes(buffer, table.offset + relativeOffset, length);
}

function requireBytes(buffer: Buffer, offset: number, length: number): void {
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
