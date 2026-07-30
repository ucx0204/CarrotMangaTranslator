import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILT_IN_BLOCK_FONTS } from "../src/shared/blockFontCatalog";

type BundledFontManifest = {
  fonts: Array<{
    id: string;
    family: string;
    locale: string;
    file: string;
    sha256: string;
  }>;
  koreanFonts: Array<{
    id: string;
    family: string;
    locale: string;
    faces: Array<{
      file: string;
      sha256: string;
      format: "ttf" | "otf";
      weight: number;
    }>;
  }>;
};

type BundledFontFace = {
  path: string;
  weight: string;
};

const ROOT = process.cwd();
const MANIFEST_PATH = join(ROOT, "third_party", "fonts", "manifest.json");
const RENDERER_STYLES_PATH = join(ROOT, "src", "renderer", "src", "styles.css");
const NEW_KOREAN_FONT_IDS = [
  "dohyeon",
  "ridi-batang",
  "cafe24-gowoonbam",
  "start-over",
  "jua",
  "gaegu",
] as const;
const FONT_SIGNATURES = {
  ttf: Buffer.from([0, 1, 0, 0]),
  otf: Buffer.from("OTTO", "ascii"),
} as const;

function readImportedStylesheets(rootPath: string) {
  const rootSource = readFileSync(rootPath, "utf8");
  return [...rootSource.matchAll(/^@import "([^"]+)";$/gm)].map((match) => {
    const path = resolve(dirname(rootPath), match[1]);
    return { path, source: readFileSync(path, "utf8") };
  });
}

function readBundledFontFaces() {
  const faces = new Map<string, BundledFontFace[]>();
  for (const stylesheet of readImportedStylesheets(RENDERER_STYLES_PATH)) {
    for (const match of stylesheet.source.matchAll(
      /@font-face\s*\{([^}]+)\}/g,
    )) {
      const family = /font-family:\s*"([^"]+)"/.exec(match[1])?.[1];
      const url = /src:\s*url\("([^"]+)"\)/.exec(match[1])?.[1];
      const weight = /font-weight:\s*([^;]+);/.exec(match[1])?.[1]?.trim();
      if (family && url && weight) {
        const familyFaces = faces.get(family) ?? [];
        familyFaces.push({
          path: resolve(dirname(stylesheet.path), url),
          weight,
        });
        faces.set(family, familyFaces);
      }
    }
  }
  return faces;
}

describe("bundled multilingual font assets", () => {
  it("keeps every catalog entry, font face, checksum, and license in sync", () => {
    const manifest = JSON.parse(
      readFileSync(MANIFEST_PATH, "utf8"),
    ) as BundledFontManifest;
    const multilingualCatalog = BUILT_IN_BLOCK_FONTS.filter(
      (font) => font.locale !== "ko",
    );
    const fontFaces = readBundledFontFaces();

    expect(manifest.fonts).toHaveLength(24);
    expect(manifest.fonts.map((font) => font.id)).toEqual(
      multilingualCatalog.map((font) => font.id),
    );

    for (const entry of manifest.fonts) {
      const catalogEntry = multilingualCatalog.find(
        (font) => font.id === entry.id,
      );
      expect(catalogEntry).toBeDefined();
      expect(entry.locale).toBe(catalogEntry?.locale);
      expect(entry.family).toBe(catalogEntry?.label);

      const fontPath = join(ROOT, ...entry.file.split("/"));
      expect(existsSync(fontPath), entry.file).toBe(true);
      const bytes = readFileSync(fontPath);
      expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0, 1, 0, 0]));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        entry.sha256,
      );

      const cssAlias = catalogEntry?.cssFamily.match(/^"([^"]+)"/)?.[1];
      expect(cssAlias).toBeTruthy();
      expect(fontFaces.get(cssAlias ?? "")?.map((face) => face.path)).toContain(
        resolve(fontPath),
      );

      const licenseDir = join(ROOT, "third_party", "fonts", entry.id);
      expect(existsSync(licenseDir), licenseDir).toBe(true);
      expect(
        readdirSync(licenseDir).some((file) =>
          /^(?:OFL|LICENSE)\.txt$/i.test(file),
        ),
      ).toBe(true);
    }
  });

  it("keeps the six redistributable Korean fonts and all of their faces in sync", () => {
    const manifest = JSON.parse(
      readFileSync(MANIFEST_PATH, "utf8"),
    ) as BundledFontManifest;
    const koreanCatalog = BUILT_IN_BLOCK_FONTS.filter(
      (font) =>
        font.locale === "ko" &&
        NEW_KOREAN_FONT_IDS.some((id) => id === font.id),
    );
    const fontFaces = readBundledFontFaces();

    expect(manifest.koreanFonts.map((font) => font.id)).toEqual(
      NEW_KOREAN_FONT_IDS,
    );
    expect(koreanCatalog.map((font) => font.id)).toEqual(NEW_KOREAN_FONT_IDS);

    for (const entry of manifest.koreanFonts) {
      const catalogEntry = koreanCatalog.find((font) => font.id === entry.id);
      expect(catalogEntry).toBeDefined();
      expect(entry.locale).toBe("ko");
      expect(entry.locale).toBe(catalogEntry?.locale);
      expect(entry.family).toBe(catalogEntry?.label);
      expect(entry.faces.length).toBeGreaterThan(0);

      const expectedCssFaces = entry.faces.map((face) => {
        const fontPath = join(ROOT, ...face.file.split("/"));
        expect(existsSync(fontPath), face.file).toBe(true);
        const bytes = readFileSync(fontPath);
        expect(bytes.subarray(0, 4)).toEqual(FONT_SIGNATURES[face.format]);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          face.sha256,
        );
        return {
          path: resolve(fontPath),
          weight: String(face.weight),
        };
      });

      const cssAlias = catalogEntry?.cssFamily.match(/^"([^"]+)"/)?.[1];
      expect(cssAlias).toBeTruthy();
      const actualCssFaces = fontFaces.get(cssAlias ?? "");
      expect(actualCssFaces).toHaveLength(expectedCssFaces.length);
      expect(actualCssFaces).toEqual(expect.arrayContaining(expectedCssFaces));

      const licenseDir = join(ROOT, "third_party", "fonts", entry.id);
      expect(existsSync(licenseDir), licenseDir).toBe(true);
      expect(
        readdirSync(licenseDir).some((file) =>
          /^(?:OFL|LICENSE)\.txt$/i.test(file),
        ),
      ).toBe(true);
    }
  });
});
