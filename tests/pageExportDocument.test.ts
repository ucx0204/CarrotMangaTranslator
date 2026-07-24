/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { parsePageExportData } from "../src/renderer/src/pageExport/documentData";

describe("page export document boundary", () => {
  it("accepts the shared artwork snapshot contract", () => {
    const element = document.createElement("script");
    element.textContent = JSON.stringify(makeDocument());

    expect(parsePageExportData(element)).toEqual(makeDocument());
  });

  it("rejects unsupported image sources and malformed blocks", () => {
    const element = document.createElement("script");
    element.textContent = JSON.stringify({
      ...makeDocument(),
      imageSrc: "https://example.test/page.png",
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
    page: {
      blocks: [],
      height: 1400,
      id: "page-1",
      name: "page.png",
      width: 1000,
    },
  };
}
