import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCustomFontLibrary } from "../src/main/customFonts";
import { readMcpFontCatalog } from "../src/main/mcp/mcpFontCatalogAdapter";
import { McpFontEntrySchema } from "../src/shared/mcpTypographyRead";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), "mcp-font-read-"));
  temporary.push(path);
  return path;
}

it("reads the actual built-in catalog without creating a custom font directory", async () => {
  const fontsDir = join(directory(), "not-created");
  const first = await readMcpFontCatalog({ fontsDir });
  const second = await readMcpFontCatalog({ fontsDir });
  expect(first.fonts.length).toBeGreaterThan(0);
  expect(first.fonts.some((font) => font.availability === "available")).toBe(
    true,
  );
  expect(
    first.fonts.every((font) => McpFontEntrySchema.safeParse(font).success),
  ).toBe(true);
  expect(second.snapshot).toBe(first.snapshot);
  expect(existsSync(fontsDir)).toBe(false);
  expect(JSON.stringify(first)).not.toMatch(
    /fileName|dataUrl|fontPath|fontsDir|unicodeRanges/,
  );
});

it("does not create directories or migrate legacy fonts in read-only query mode", () => {
  const parent = directory();
  const fontsDir = join(parent, "fonts");
  const legacy = join(parent, "legacy");
  mkdirSync(legacy);
  const reportError = vi.fn();
  const library = createCustomFontLibrary({
    getFontsDirectory: () => fontsDir,
    getLegacyBundledFontsDirectory: () => legacy,
    readOnlyQueries: true,
    reportError,
  });
  expect(library.getFontLibrarySnapshot().customFonts).toEqual([]);
  expect(library.listCustomFonts()).toEqual([]);
  expect(library.resolveCustomFontFilePath("not-a-font")).toBeNull();
  expect(existsSync(fontsDir)).toBe(false);
  expect(reportError).not.toHaveBeenCalled();
});

it("retains existing default query initialization", () => {
  const fontsDir = join(directory(), "fonts");
  const library = createCustomFontLibrary({
    getFontsDirectory: () => fontsDir,
    reportError: vi.fn(),
  });
  expect(library.getFontLibrarySnapshot().customFonts).toEqual([]);
  expect(existsSync(fontsDir)).toBe(true);
});

it("refuses corrupt registry data rather than presenting an empty valid snapshot", async () => {
  const fontsDir = directory();
  writeFileSync(join(fontsDir, "index.json"), "{broken");
  await expect(readMcpFontCatalog({ fontsDir })).rejects.toThrow();
});

it("reports an existing but uninspectable custom font without returning its path", async () => {
  const fontsDir = directory();
  const id = "11111111-1111-4111-8111-111111111111";
  writeFileSync(join(fontsDir, `${id}.ttf`), "tiny");
  writeFileSync(
    join(fontsDir, "index.json"),
    JSON.stringify([
      {
        id,
        label: "Custom test",
        family: `MGTUser-${id}`,
        fileName: `${id}.ttf`,
      },
    ]),
  );
  writeFileSync(
    join(fontsDir, "preferences.json"),
    JSON.stringify({
      favoriteIds: [id],
      hiddenIds: [id],
      orderedIds: [id],
      defaultFontId: id,
    }),
  );
  const result = await readMcpFontCatalog({ fontsDir });
  expect(result.fonts.find((font) => font.fontId === id)).toMatchObject({
    source: "custom",
    availability: "unverified",
    baseWeight: null,
    hidden: true,
    favorite: true,
    defaultFont: true,
  });
  expect(JSON.stringify(result)).not.toContain(fontsDir);
  expect(JSON.stringify(result)).not.toContain(`${id}.ttf`);
});
