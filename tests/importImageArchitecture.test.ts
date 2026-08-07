import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("import image security architecture", () => {
  it("does not use Electron nativeImage in the import decoding boundary", () => {
    const sources = [
      "src/main/libraryStore/importImageRuntime.ts",
      "src/main/libraryStore/importImages.ts",
      "src/main/libraryStore/importPageMaterialize.ts",
      "src/main/libraryStore/shareImportMaterialize.ts",
    ].map((path) => readFileSync(path, "utf8"));

    for (const source of sources) {
      expect(source).not.toContain("nativeImage");
      expect(source).not.toContain("createFromPath");
    }
  });

  it("removes the old post-decode size checker and Buffer WebP import converter", () => {
    const importImagesSource = readFileSync(
      "src/main/libraryStore/importImages.ts",
      "utf8",
    );
    const librarySources = [
      importImagesSource,
      readFileSync("src/main/libraryStore/importPageMaterialize.ts", "utf8"),
      readFileSync("src/main/libraryStore/shareImportMaterialize.ts", "utf8"),
    ].join("\n");

    expect(librarySources).not.toContain("readDecodedImportImageSize");
    expect(librarySources).not.toContain("decodeToPng");
    expect(librarySources).not.toContain("convertImageToPngBufferWithFfmpeg");
  });

  it("keeps max_pixels and file conversion without stdout buffering", () => {
    const validationSource = readFileSync(
      "src/main/runtime/assets/image-file-validation.cjs",
      "utf8",
    );
    const processSource = readFileSync(
      "src/main/runtime/assets/image-file-process.cjs",
      "utf8",
    );

    expect(validationSource).toContain('"-max_pixels"');
    expect(validationSource).toContain('"-fs"');
    expect(validationSource).not.toContain("pipe:1");
    expect(validationSource).not.toContain("stdoutChunks");
    expect(processSource).not.toContain("pipe:1");
    expect(processSource).not.toContain("stdoutChunks");
    expect(processSource).toContain('["ignore", "ignore", "pipe"]');
  });

  it("preflights source headers and compares inpainted dimensions", () => {
    const importSources = [
      readFileSync("src/main/libraryStore/importImages.ts", "utf8"),
      readFileSync("src/main/libraryStore/importPageMaterialize.ts", "utf8"),
      readFileSync("src/main/libraryStore/shareImportMaterialize.ts", "utf8"),
    ].join("\n");

    expect(importSources).toContain("probeImageFile");
    expect(importSources).toContain("probeImageBuffer");
    expect(importSources).toContain("assertSameImageDimensions");
    expect(importSources).toContain("inpaintingDimensionsMismatch");
  });
});
