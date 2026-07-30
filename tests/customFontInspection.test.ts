import { describe, expect, it } from "vitest";
import {
  countFontCandidateCodePointsInRange,
  fontCandidateCoversRange,
  fontCandidateSupportsText,
} from "../src/main/fontCoverage";
import { inspectCustomFontBuffer } from "../src/main/customFontInspection";

type CmapGroup = readonly [
  startCodePoint: number,
  endCodePoint: number,
  startGlyphId: number,
];

describe("custom font inspection", () => {
  it("reads format 4 coverage exactly and extracts safe style metrics", () => {
    const cmap = makeCmap([
      {
        platformId: 3,
        encodingId: 1,
        data: makeFormat4([
          { start: 0x41, end: 0x43, delta: 1 - 0x41 },
          {
            start: 0xac00,
            end: 0xac02,
            delta: 0,
            glyphIds: [10, 0, 12],
          },
        ]),
      },
    ]);
    const os2 = Buffer.alloc(64);
    os2.writeUInt16BE(800, 4);
    os2.writeUInt16BE(3, 6);
    os2[32] = 2;
    os2[33] = 11;
    os2.writeUInt16BE(1, 62);
    const head = Buffer.alloc(46);
    const inspection = inspectCustomFontBuffer(
      makeSfnt([
        ["cmap", cmap],
        ["OS/2", os2],
        ["head", head],
      ]),
    );

    expect(inspection).toMatchObject({
      weight: 800,
      width: 3,
      italic: true,
      serif: false,
      supportedLocales: [],
      unicodeRanges: [
        [0x41, 0x43],
        [0xac00, 0xac00],
        [0xac02, 0xac02],
      ],
    });
    expect(fontCandidateSupportsText(inspection, "AC\n가갂\uFE0F")).toBe(true);
    expect(fontCandidateSupportsText(inspection, "가각")).toBe(false);
  });

  it("unions format 12 and 13 cmaps, including non-BMP glyph coverage", () => {
    const format12Groups: CmapGroup[] = [
      [0x30, 0x30, 1],
      [0x41, 0x41, 2],
      [0x61, 0x61, 3],
      [0x3042, 0x3042, 4],
      [0x30a2, 0x30a2, 5],
      [0x65e5, 0x65e5, 6],
      [0xac00, 0xac00, 7],
      [0xb098, 0xb098, 8],
      [0xd55c, 0xd55c, 9],
      [0x1f600, 0x1f602, 0],
    ];
    const cmap = makeCmap([
      {
        platformId: 3,
        encodingId: 10,
        data: makeFormat12Or13(12, format12Groups),
      },
      {
        platformId: 0,
        encodingId: 4,
        data: makeFormat12Or13(13, [
          [0x4e2d, 0x4e2d, 10],
          [0x56fd, 0x56fd, 10],
          [0x570b, 0x570b, 10],
          [0x6000, 0x6002, 0],
        ]),
      },
    ]);
    const inspection = inspectCustomFontBuffer(makeSfnt([["cmap", cmap]]));

    expect(inspection.supportedLocales).toEqual([
      "ko",
      "en",
      "ja",
      "zh-Hans",
      "zh-Hant",
    ]);
    expect(
      fontCandidateSupportsText(inspection, "0Aaあア日가나한中国國😁😂"),
    ).toBe(true);
    expect(fontCandidateSupportsText(inspection, "😀")).toBe(false);
    expect(fontCandidateSupportsText(inspection, "\u6001")).toBe(false);
    expect(inspection).toMatchObject({
      weight: 400,
      width: 5,
      italic: false,
    });
    expect(inspection.serif).toBeUndefined();
  });

  it("uses metric defaults for short or invalid optional tables", () => {
    const cmap = makeCmap([
      {
        platformId: 3,
        encodingId: 10,
        data: makeFormat12Or13(12, [[0x41, 0x41, 1]]),
      },
    ]);
    const os2 = Buffer.alloc(8);
    os2.writeUInt16BE(0, 4);
    os2.writeUInt16BE(99, 6);
    const inspection = inspectCustomFontBuffer(
      makeSfnt([
        ["cmap", cmap],
        ["OS/2", os2],
        ["head", Buffer.alloc(45)],
      ]),
    );

    expect(inspection).toMatchObject({
      weight: 400,
      width: 5,
      italic: false,
    });
    expect(inspection.serif).toBeUndefined();
  });

  it("checks complete ranges and counts sparse coverage without expanding them", () => {
    const candidate = {
      unicodeRanges: [
        [0x41, 0x5a],
        [0xac00, 0xac10],
        [0xac20, 0xac2f],
      ] as const,
    };

    expect(fontCandidateCoversRange(candidate, 0x41, 0x5a)).toBe(true);
    expect(fontCandidateCoversRange(candidate, 0xac00, 0xac2f)).toBe(false);
    expect(countFontCandidateCodePointsInRange(candidate, 0xac08, 0xac27)).toBe(
      17,
    );
  });

  it("honors the head italic flag when OS/2 does not provide it", () => {
    const cmap = makeCmap([
      {
        platformId: 3,
        encodingId: 10,
        data: makeFormat12Or13(12, [[0x41, 0x41, 1]]),
      },
    ]);
    const head = Buffer.alloc(46);
    head.writeUInt16BE(2, 44);

    expect(
      inspectCustomFontBuffer(
        makeSfnt([
          ["cmap", cmap],
          ["head", head],
        ]),
      ).italic,
    ).toBe(true);
  });

  it("rejects group data outside a cmap subtable's declared length", () => {
    const format12 = makeFormat12Or13(12, [[0x41, 0x41, 1]]);
    format12.writeUInt32BE(16, 4);
    const cmap = makeCmap([{ platformId: 3, encodingId: 10, data: format12 }]);

    expect(() => inspectCustomFontBuffer(makeSfnt([["cmap", cmap]]))).toThrow(
      /subtable read is out of bounds/i,
    );
  });

  it("parses a repeatedly referenced cmap subtable only once", () => {
    const format12 = makeFormat12Or13(12, [[0x41, 0x43, 1]]);
    const cmap = makeRepeatedCmapReference(format12, 4096);

    expect(inspectCustomFontBuffer(makeSfnt([["cmap", cmap]]))).toMatchObject({
      unicodeRanges: [[0x41, 0x43]],
    });
  });
});

function makeSfnt(tables: Array<readonly [string, Buffer]>): Buffer {
  const directoryLength = 12 + tables.length * 16;
  let nextOffset = directoryLength;
  const records = tables.map(([tag, data]) => {
    const record = { tag, data, offset: nextOffset };
    nextOffset += align4(data.length);
    return record;
  });
  const result = Buffer.alloc(nextOffset);
  result.writeUInt32BE(0x00010000, 0);
  result.writeUInt16BE(records.length, 4);
  records.forEach((record, index) => {
    const recordOffset = 12 + index * 16;
    result.write(record.tag, recordOffset, 4, "latin1");
    result.writeUInt32BE(record.offset, recordOffset + 8);
    result.writeUInt32BE(record.data.length, recordOffset + 12);
    record.data.copy(result, record.offset);
  });
  return result;
}

function makeCmap(
  subtables: Array<{
    platformId: number;
    encodingId: number;
    data: Buffer;
  }>,
): Buffer {
  const headerLength = 4 + subtables.length * 8;
  const length =
    headerLength +
    subtables.reduce((total, subtable) => total + subtable.data.length, 0);
  const result = Buffer.alloc(length);
  result.writeUInt16BE(subtables.length, 2);
  let offset = headerLength;
  subtables.forEach((subtable, index) => {
    const recordOffset = 4 + index * 8;
    result.writeUInt16BE(subtable.platformId, recordOffset);
    result.writeUInt16BE(subtable.encodingId, recordOffset + 2);
    result.writeUInt32BE(offset, recordOffset + 4);
    subtable.data.copy(result, offset);
    offset += subtable.data.length;
  });
  return result;
}

function makeRepeatedCmapReference(data: Buffer, count: number): Buffer {
  const headerLength = 4 + count * 8;
  const result = Buffer.alloc(headerLength + data.length);
  result.writeUInt16BE(count, 2);
  for (let index = 0; index < count; index += 1) {
    const recordOffset = 4 + index * 8;
    result.writeUInt16BE(3, recordOffset);
    result.writeUInt16BE(10, recordOffset + 2);
    result.writeUInt32BE(headerLength, recordOffset + 4);
  }
  data.copy(result, headerLength);
  return result;
}

function makeFormat4(
  mappedSegments: Array<{
    start: number;
    end: number;
    delta: number;
    glyphIds?: number[];
  }>,
): Buffer {
  const segments = [
    ...mappedSegments,
    { start: 0xffff, end: 0xffff, delta: 1 },
  ];
  const segCount = segments.length;
  const glyphCount = segments.reduce(
    (total, segment) => total + (segment.glyphIds?.length ?? 0),
    0,
  );
  const glyphArrayOffset = 16 + segCount * 8;
  const result = Buffer.alloc(glyphArrayOffset + glyphCount * 2);
  result.writeUInt16BE(4, 0);
  result.writeUInt16BE(result.length, 2);
  result.writeUInt16BE(segCount * 2, 6);
  const endCodesOffset = 14;
  const startCodesOffset = endCodesOffset + segCount * 2 + 2;
  const deltasOffset = startCodesOffset + segCount * 2;
  const rangeOffsetsOffset = deltasOffset + segCount * 2;
  let glyphIndex = 0;
  segments.forEach((segment, index) => {
    result.writeUInt16BE(segment.end, endCodesOffset + index * 2);
    result.writeUInt16BE(segment.start, startCodesOffset + index * 2);
    result.writeInt16BE(segment.delta, deltasOffset + index * 2);
    if (!segment.glyphIds) {
      return;
    }
    const rangeOffsetPosition = rangeOffsetsOffset + index * 2;
    result.writeUInt16BE(
      glyphArrayOffset + glyphIndex * 2 - rangeOffsetPosition,
      rangeOffsetPosition,
    );
    for (const glyphId of segment.glyphIds) {
      result.writeUInt16BE(glyphId, glyphArrayOffset + glyphIndex * 2);
      glyphIndex += 1;
    }
  });
  return result;
}

function makeFormat12Or13(
  format: 12 | 13,
  groups: readonly CmapGroup[],
): Buffer {
  const result = Buffer.alloc(16 + groups.length * 12);
  result.writeUInt16BE(format, 0);
  result.writeUInt32BE(result.length, 4);
  result.writeUInt32BE(groups.length, 12);
  groups.forEach(([start, end, glyphId], index) => {
    const offset = 16 + index * 12;
    result.writeUInt32BE(start, offset);
    result.writeUInt32BE(end, offset + 4);
    result.writeUInt32BE(glyphId, offset + 8);
  });
  return result;
}

function align4(value: number): number {
  return (value + 3) & ~3;
}
