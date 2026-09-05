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
  rmSync(join(f.legacy, "ko", `${old.id}.ttf`));
  expect(f.library.removeCustomFont(old.customId)).toEqual([]);
  expect(existsSync(file)).toBe(false);
  expect(f.reportError).not.toHaveBeenCalled();
});

it("does not install absent demoted fonts or replace a pre-existing custom font index", () => {
  const f = fixture();
  expect(f.library.getFontLibrarySnapshot().customFonts).toEqual([]);
  expect(existsSync(join(f.fonts, "index.json"))).toBe(false);
  expect(f.reportError).not.toHaveBeenCalled();
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
