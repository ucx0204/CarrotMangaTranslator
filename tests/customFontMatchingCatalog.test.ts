import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadCustomFontMatchingCandidatesWith,
  type CustomFontMatchingCatalogDependencies,
} from "../src/main/customFontMatchingCatalog";
import { fontCandidateSupportsText } from "../src/main/fontCoverage";
import type {
  CustomFont,
  FontLibrarySnapshot,
} from "../src/shared/libraryTypes";

const tempDirs: string[] = [];
const FONT_A_ID = "11111111-1111-4111-8111-111111111111";
const FONT_B_ID = "22222222-2222-4222-8222-222222222222";

describe("custom font matching catalog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const path = tempDirs.pop();
      if (path) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  });

  it("takes one snapshot and preserves deterministic preference metadata", () => {
    const root = makeTempDir();
    const fontA = makeFont(FONT_A_ID, "Readable");
    const fontB = makeFont(FONT_B_ID, "Impact");
    const paths = writeFonts(root, [
      [fontA, makeTestFont([0x30, 0x41, 0x61], 400)],
      [fontB, makeTestFont([0x30, 0x41, 0x61], 800)],
    ]);
    const snapshot: FontLibrarySnapshot = {
      customFonts: [fontB, fontA],
      preferences: {
        favoriteIds: [FONT_B_ID],
        orderedIds: [FONT_B_ID, FONT_A_ID],
        defaultFontId: FONT_A_ID,
      },
    };
    const dependencies = makeDependencies(root, snapshot, paths);

    const candidates = loadCustomFontMatchingCandidatesWith(dependencies);

    expect(dependencies.getFontLibrarySnapshot).toHaveBeenCalledTimes(1);
    expect(dependencies.resolveCustomFontFilePath).toHaveBeenCalledTimes(2);
    expect(candidates.map((candidate) => candidate.fontId)).toEqual([
      FONT_A_ID,
      FONT_B_ID,
    ]);
    expect(candidates[0]).toMatchObject({
      label: "Readable",
      supportedLocales: ["en"],
      weight: 400,
      favorite: false,
      defaultFont: true,
      preferenceRank: 1,
    });
    expect(candidates[1]).toMatchObject({
      label: "Impact",
      supportedLocales: ["en"],
      weight: 800,
      favorite: true,
      defaultFont: false,
      preferenceRank: 0,
    });
  });

  it("ignores corrupt cache JSON and replaces it with inspected data", () => {
    const root = makeTempDir();
    const font = makeFont(FONT_A_ID, "Recovered");
    const paths = writeFonts(root, [
      [font, makeTestFont([0x30, 0x41, 0x61], 500)],
    ]);
    const cachePath = join(root, "automatic-font-matching.json");
    writeFileSync(cachePath, "{broken", "utf8");
    const dependencies = makeDependencies(root, makeSnapshot([font]), paths);

    const candidates = loadCustomFontMatchingCandidatesWith(dependencies);
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.weight).toBe(500);
    expect(cache).toMatchObject({
      schemaVersion: 1,
      fonts: [{ fontId: FONT_A_ID, analyzerVersion: 1 }],
    });
  });

  it("reuses a valid cache record when file size and mtime are unchanged", () => {
    const root = makeTempDir();
    const font = makeFont(FONT_A_ID, "Cached");
    const fontPath = join(root, font.fileName);
    writeFileSync(fontPath, Buffer.alloc(64, 0xff));
    const info = statSync(fontPath);
    const cachePath = join(root, "automatic-font-matching.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        schemaVersion: 1,
        fonts: [
          {
            fontId: FONT_A_ID,
            fileName: font.fileName,
            fileSize: info.size,
            mtimeMs: info.mtimeMs,
            sha256: "a".repeat(64),
            analyzerVersion: 1,
            inspection: {
              supportedLocales: ["en"],
              unicodeRanges: [
                [0x61, 0x61],
                [0x30, 0x30],
                [0x41, 0x41],
              ],
              weight: 650,
              width: 4,
              italic: true,
            },
          },
        ],
      }),
      "utf8",
    );
    const dependencies = makeDependencies(
      root,
      makeSnapshot([font]),
      new Map([[FONT_A_ID, fontPath]]),
    );

    const candidates = loadCustomFontMatchingCandidatesWith(dependencies);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      weight: 650,
      width: 4,
      italic: true,
      unicodeRanges: [
        [0x30, 0x30],
        [0x41, 0x41],
        [0x61, 0x61],
      ],
    });
  });

  it("re-inspects and refreshes coverage when the font file changes", () => {
    const root = makeTempDir();
    const font = makeFont(FONT_A_ID, "Changing");
    const fontPath = join(root, font.fileName);
    writeFileSync(fontPath, makeTestFont([0x41], 400));
    const dependencies = makeDependencies(
      root,
      makeSnapshot([font]),
      new Map([[FONT_A_ID, fontPath]]),
    );
    const first = loadCustomFontMatchingCandidatesWith(dependencies);

    writeFileSync(fontPath, makeTestFont([0x41, 0x5a], 700));
    const second = loadCustomFontMatchingCandidatesWith(dependencies);

    expect(first[0]?.weight).toBe(400);
    expect(
      fontCandidateSupportsText(first[0] ?? { unicodeRanges: [] }, "Z"),
    ).toBe(false);
    expect(second[0]?.weight).toBe(700);
    expect(
      fontCandidateSupportsText(second[0] ?? { unicodeRanges: [] }, "AZ"),
    ).toBe(true);
    const cache = JSON.parse(
      readFileSync(join(root, "automatic-font-matching.json"), "utf8"),
    );
    expect(cache.fonts[0]).toMatchObject({
      fileSize: statSync(fontPath).size,
      analyzerVersion: 1,
    });
  });

  it("returns inspected candidates and reports a cache rename failure", () => {
    const root = makeTempDir();
    const font = makeFont(FONT_A_ID, "No cache");
    const paths = writeFonts(root, [[font, makeTestFont([0x41], 400)]]);
    const cacheDirectory = join(root, "cache-target");
    mkdirSync(cacheDirectory);
    const dependencies = makeDependencies(
      root,
      makeSnapshot([font]),
      paths,
      cacheDirectory,
    );

    const candidates = loadCustomFontMatchingCandidatesWith(dependencies);

    expect(candidates).toHaveLength(1);
    expect(dependencies.reportWarning).toHaveBeenCalledWith(
      "Custom font auto-match cache write failed",
      expect.objectContaining({
        cachePath: cacheDirectory,
        error: expect.any(Error),
      }),
    );
    expect(readdirSync(root).some((name) => name.endsWith(".tmp"))).toBe(false);
  });
});

function makeTempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "manga-font-match-"));
  tempDirs.push(root);
  return root;
}

function makeFont(id: string, label: string): CustomFont {
  return {
    id,
    label,
    family: `MGTUser-${id}`,
    fileName: `${id}.ttf`,
  };
}

function makeSnapshot(customFonts: CustomFont[]): FontLibrarySnapshot {
  return {
    customFonts,
    preferences: {
      favoriteIds: [],
      orderedIds: [],
      defaultFontId: "default",
    },
  };
}

function writeFonts(
  root: string,
  entries: Array<readonly [CustomFont, Buffer]>,
): Map<string, string> {
  return new Map(
    entries.map(([font, bytes]) => {
      const path = join(root, font.fileName);
      writeFileSync(path, bytes);
      return [font.id, path] as const;
    }),
  );
}

function makeDependencies(
  root: string,
  snapshot: FontLibrarySnapshot,
  paths: ReadonlyMap<string, string>,
  cachePath = join(root, "automatic-font-matching.json"),
): CustomFontMatchingCatalogDependencies {
  return {
    getFontLibrarySnapshot: vi.fn(() => snapshot),
    resolveCustomFontFilePath: vi.fn(
      (fontId: string) => paths.get(fontId) ?? null,
    ),
    getCachePath: () => cachePath,
    reportWarning: vi.fn(),
  };
}

function makeTestFont(codePoints: number[], weight: number): Buffer {
  const subtable = Buffer.alloc(16 + codePoints.length * 12);
  subtable.writeUInt16BE(12, 0);
  subtable.writeUInt32BE(subtable.length, 4);
  subtable.writeUInt32BE(codePoints.length, 12);
  codePoints.forEach((codePoint, index) => {
    const offset = 16 + index * 12;
    subtable.writeUInt32BE(codePoint, offset);
    subtable.writeUInt32BE(codePoint, offset + 4);
    subtable.writeUInt32BE(index + 1, offset + 8);
  });
  const cmap = Buffer.alloc(12 + subtable.length);
  cmap.writeUInt16BE(1, 2);
  cmap.writeUInt16BE(3, 4);
  cmap.writeUInt16BE(10, 6);
  cmap.writeUInt32BE(12, 8);
  subtable.copy(cmap, 12);
  const os2 = Buffer.alloc(8);
  os2.writeUInt16BE(weight, 4);
  os2.writeUInt16BE(5, 6);
  return makeSfnt([
    ["cmap", cmap],
    ["OS/2", os2],
  ]);
}

function makeSfnt(tables: Array<readonly [string, Buffer]>): Buffer {
  const directoryLength = 12 + tables.length * 16;
  let nextOffset = directoryLength;
  const records = tables.map(([tag, data]) => {
    const record = { tag, data, offset: nextOffset };
    nextOffset += (data.length + 3) & ~3;
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
