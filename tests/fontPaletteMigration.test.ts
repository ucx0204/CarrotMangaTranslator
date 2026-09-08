import { afterEach, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEMOTED_BLOCK_FONTS } from "../src/shared/demotedBlockFonts";
import { createCustomFontLibrary } from "../src/main/customFonts";
import { preserveDemotedFonts } from "../src/main/demotedFontMigration";
import {
  createBlockFontCatalog,
  normalizeBlockFontFamily,
  resolveBlockFontFamily,
} from "../src/renderer/src/lib/fonts";
import { BUILT_IN_BLOCK_FONTS } from "../src/shared/blockFontCatalog";
import {
  additionalFontCoverage,
  verifyAdditionalFontFiles,
} from "../src/main/pipeline/fontCatalogReferenceExtension";
import { fontCandidateSupportsText } from "../src/main/fontCoverage";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => "unused" },
}));
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "font-palette-migration-"));
  directories.push(root);
  const legacy = join(root, "bundled");
  const fonts = join(root, "fonts");
  mkdirSync(join(legacy, "ko"), { recursive: true });
  const reportError = vi.fn();
  return {
    root,
    legacy,
    fonts,
    reportError,
    library: createCustomFontLibrary({
      getFontsDirectory: () => fonts,
      getLegacyBundledFontsDirectory: () => legacy,
      reportError,
    }),
  };
}

it("preserves installed bytes, preferences and saved block aliases exactly once as removable custom fonts", () => {
  const f = fixture();
  const old = DEMOTED_BLOCK_FONTS[0];
  const bytes = Buffer.from([0, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
  writeFileSync(join(f.legacy, "ko", `${old.id}.ttf`), bytes);
  mkdirSync(f.fonts);
  writeFileSync(
    join(f.fonts, "preferences.json"),
    JSON.stringify({
      defaultFontId: old.id,
      favoriteIds: [old.id],
      orderedIds: [old.id],
      hiddenIds: [],
    }),
  );
  const snapshot = f.library.getFontLibrarySnapshot();
  expect(snapshot.customFonts.map((font) => font.id)).toEqual([old.customId]);
  expect(snapshot.preferences).toMatchObject({
    defaultFontId: old.customId,
    favoriteIds: [old.customId],
    orderedIds: [old.customId],
  });
  const file = f.library.resolveCustomFontFilePath(old.id);
  if (!file) throw new Error("Missing migrated file");
  expect(readFileSync(file)).toEqual(bytes);
  expect(f.library.listCustomFonts()).toEqual(snapshot.customFonts);
  const catalog = createBlockFontCatalog(
    snapshot.customFonts,
    snapshot.preferences,
  );
  expect(normalizeBlockFontFamily(old.id, catalog)).toBe(old.customId);
  expect(resolveBlockFontFamily(old.id, catalog)).toContain(
    `MGTUser-${old.customId}`,
  );
  expect(
    BUILT_IN_BLOCK_FONTS.some((font) => font.id === (old.id as string)),
  ).toBe(false);
  expect(existsSync(join(f.legacy, "ko", `${old.id}.ttf`))).toBe(true);
  expect(f.library.removeCustomFont(old.customId)).toEqual([]);
  expect(existsSync(file)).toBe(false);
  const restarted = createCustomFontLibrary({
    getFontsDirectory: () => f.fonts,
    getLegacyBundledFontsDirectory: () => f.legacy,
    reportError: f.reportError,
  });
  expect(restarted.getFontLibrarySnapshot().customFonts).toEqual([]);
  expect(restarted.resolveCustomFontFilePath(old.id)).toBeNull();
  expect(readFileSync(join(f.legacy, "ko", `${old.id}.ttf`))).toEqual(bytes);
  expect(f.reportError).not.toHaveBeenCalled();
});

it("does not install absent demoted fonts or replace a pre-existing custom font index", () => {
  const f = fixture();
  expect(f.library.getFontLibrarySnapshot().customFonts).toEqual([]);
  expect(f.library.resolveCustomFontFilePath("single-day")).toBeNull();
  expect(existsSync(join(f.fonts, "index.json"))).toBe(false);
  expect(f.reportError).not.toHaveBeenCalled();
});

it.each(["copied", "indexed"])(
  "resumes an interrupted %s migration and records deletion across restart",
  (stage) => {
    const f = fixture();
    const old = DEMOTED_BLOCK_FONTS[0];
    const bytes = Buffer.from([0, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
    writeFileSync(join(f.legacy, "ko", `${old.id}.ttf`), bytes);
    mkdirSync(f.fonts);
    writeFileSync(join(f.fonts, `${old.customId}.ttf`), bytes);
    if (stage === "indexed")
      writeFileSync(
        join(f.fonts, "index.json"),
        JSON.stringify([
          {
            id: old.customId,
            label: old.label,
            family: `MGTUser-${old.customId}`,
            fileName: `${old.customId}.ttf`,
          },
        ]),
      );
    preserveDemotedFonts(f.fonts, f.legacy);
    expect(f.library.listCustomFonts().map((font) => font.id)).toEqual([
      old.customId,
    ]);
    f.library.removeCustomFont(old.customId);
    preserveDemotedFonts(f.fonts, f.legacy);
    expect(
      JSON.parse(readFileSync(join(f.fonts, "index.json"), "utf8")),
    ).toEqual([]);
    expect(existsSync(join(f.fonts, `${old.customId}.ttf`))).toBe(false);
    expect(readFileSync(join(f.legacy, "ko", `${old.id}.ttf`))).toEqual(bytes);
  },
);

it("does not mark an absent legacy font as already migrated", () => {
  const f = fixture();
  preserveDemotedFonts(f.fonts, f.legacy);
  const old = DEMOTED_BLOCK_FONTS[0];
  writeFileSync(
    join(f.legacy, "ko", `${old.id}.ttf`),
    Buffer.from([0, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]),
  );
  preserveDemotedFonts(f.fonts, f.legacy);
  expect(f.library.listCustomFonts().map((font) => font.id)).toEqual([
    old.customId,
  ]);
});

it("rejects malformed preferences and preserves an unreadable existing index during migration", () => {
  const f = fixture();
  expect(f.library.saveFontPreferences(null, [])).toMatchObject({
    favoriteIds: [],
    orderedIds: [],
    hiddenIds: [],
  });
  expect(
    f.library.saveFontPreferences(
      {
        defaultFontId: 42,
        favoriteIds: [42, null, "single-day", "missing"],
        orderedIds: "invalid",
        hiddenIds: [false],
      },
      [],
    ),
  ).toMatchObject({ favoriteIds: [], orderedIds: [], hiddenIds: [] });
  writeFileSync(join(f.fonts, "index.json"), "{broken");
  expect(f.library.listCustomFonts()).toEqual([]);
  expect(readFileSync(join(f.fonts, "index.json"), "utf8")).toBe("{broken");
  expect(f.reportError).toHaveBeenCalled();
});

it("verifies all four new faces and rejects empty Hangul outlines as font coverage", () => {
  verifyAdditionalFontFiles([
    join(process.cwd(), "src/renderer/src/assets/fonts"),
  ]);
  for (const id of ["kkubulim", "geummyeon-seongsil", "shilla-culture"]) {
    const unicodeRanges = additionalFontCoverage(id);
    if (!unicodeRanges) throw new Error("Missing coverage");
    expect(
      fontCandidateSupportsText(
        { unicodeRanges: unicodeRanges },
        "지금 무슨 일이야?",
      ),
    ).toBe(true);
    expect(
      fontCandidateSupportsText({ unicodeRanges: unicodeRanges }, "갂"),
    ).toBe(false);
  }
});
