import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("page export raster safety architecture", () => {
  it("preflights the image before HTML build and BrowserWindow page load", () => {
    const source = readFileSync("src/main/pageExport.ts", "utf8");
    const preflightIndex = source.indexOf(
      "resolveExportImageSource(page, options, signal)",
    );
    const buildHtmlIndex = source.indexOf(
      ".buildHtml(page, image.src, image.size, {",
    );
    const loadIndex = source.indexOf(".loadFile(htmlPath)");

    expect(preflightIndex).toBeGreaterThanOrEqual(0);
    expect(buildHtmlIndex).toBeGreaterThan(preflightIndex);
    expect(loadIndex).toBeGreaterThan(buildHtmlIndex);
  });

  it("checks the screenshot string budget before Buffer.from", () => {
    const source = readFileSync("src/main/pageExportRasterSafety.ts", "utf8");
    const decoderIndex = source.indexOf(
      "export function decodeBoundedPageExportScreenshot",
    );
    const lengthCheckIndex = source.indexOf(
      "data.length > maxBase64Chars",
      decoderIndex,
    );
    const estimateIndex = source.indexOf(
      "estimateBase64DecodedByteLength(data)",
      decoderIndex,
    );
    const bufferIndex = source.indexOf(
      'Buffer.from(data, "base64")',
      decoderIndex,
    );

    expect(lengthCheckIndex).toBeGreaterThan(decoderIndex);
    expect(estimateIndex).toBeGreaterThan(lengthCheckIndex);
    expect(bufferIndex).toBeGreaterThan(estimateIndex);
  });

  it("removes the old 100000 screenshot checker and nativeImage fallback", () => {
    const source = readFileSync("src/main/pageExport.ts", "utf8");

    expect(source).not.toMatch(
      /value\.width[\s\S]{0,200}100000[\s\S]{0,300}value\.height[\s\S]{0,200}100000/,
    );
    expect(source).not.toContain("nativeImage");
    expect(source).not.toContain("createFromBuffer");
  });

  it("rechecks renderer PNG data before the job writes it", () => {
    const source = readFileSync(
      "src/main/jobs/pageImageExportJobRunner.ts",
      "utf8",
    );
    const assertionIndex = source.indexOf("assertPageExportPngBuffer(");
    const writeIndex = source.indexOf(
      "dependencies.runtime.writeImage ?? dependencies.runtime.writePng",
      assertionIndex,
    );

    expect(assertionIndex).toBeGreaterThanOrEqual(0);
    expect(writeIndex).toBeGreaterThan(assertionIndex);
  });

  it("clears the production :root background for transparent PSD captures", () => {
    const entry = readFileSync(
      "src/renderer/src/pageExport/browserEntry.tsx",
      "utf8",
    );
    const styles = readFileSync(
      "src/renderer/src/pageExport/styles.css",
      "utf8",
    );

    expect(entry).toContain(
      'document.documentElement.dataset.transparentBackground = "1"',
    );
    expect(styles).toContain('html[data-transparent-background="1"]');
  });
});
