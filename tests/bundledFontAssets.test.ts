import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
};

const ROOT = process.cwd();
const MANIFEST_PATH = join(ROOT, "third_party", "fonts", "manifest.json");

describe("bundled multilingual font assets", () => {
  it("keeps every catalog entry, font face, checksum, and license in sync", () => {
    const manifest = JSON.parse(
      readFileSync(MANIFEST_PATH, "utf8"),
    ) as BundledFontManifest;
    const multilingualCatalog = BUILT_IN_BLOCK_FONTS.filter(
      (font) => font.locale !== "ko",
    );
    const styles = readFileSync(
      join(ROOT, "src", "renderer", "src", "styles.css"),
      "utf8",
    );

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
      expect(styles).toContain(`font-family: "${cssAlias}"`);
      expect(styles).toContain(entry.file.replace("src/renderer/src/", "./"));

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
