/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { parsePageExportData } from "../src/renderer/src/pageExport/documentData";

describe("page export document boundary", () => {
  it("accepts the shared artwork snapshot contract", () => {
    const element = document.createElement("script");
    element.textContent = JSON.stringify(makeDocument());

    expect(parsePageExportData(element)).toEqual(makeDocument());
  });

  it.each(["data:image/jpeg;base64,", "data:image/webp;base64,"])(
    "accepts supported raster data URLs (%s)",
    (imageSrc) => {
      const element = document.createElement("script");
      const documentData = { ...makeDocument(), imageSrc };
      element.textContent = JSON.stringify(documentData);

      expect(parsePageExportData(element)).toEqual(documentData);
    },
  );

  it.each([
    "https://example.test/page.png",
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "data:text/html;base64,PGgxPnRlc3Q8L2gxPg==",
  ])("rejects unsupported image sources (%s)", (imageSrc) => {
    const element = document.createElement("script");
    element.textContent = JSON.stringify({ ...makeDocument(), imageSrc });

    expect(() => parsePageExportData(element)).toThrow(
      "Page export data has an invalid shape.",
    );
  });

  it("rejects malformed blocks", () => {
    const element = document.createElement("script");
    element.textContent = JSON.stringify({
      ...makeDocument(),
      page: {
        ...makeDocument().page,
        blocks: [{ id: "missing-render-contract" }],
      },
    });

    expect(() => parsePageExportData(element)).toThrow(
      "Page export data has an invalid shape.",
    );
  });
});

function makeDocument() {
  return {
    fontLibrary: {
      customFonts: [],
      preferences: {
        defaultFontId: "default",
        favoriteIds: [],
        orderedIds: [],
      },
    },
    imageSrc: "data:image/png;base64,",
    outputSize: { width: 836, height: 1200 },
    page: {
      blocks: [],
      height: 1400,
      id: "page-1",
      name: "page.png",
      width: 1000,
    },
  };
}
