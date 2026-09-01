import { describe, expect, it } from "vitest";
import { PageExportDocumentDataSchema } from "../src/shared/pageExportContracts";

describe("page export document raster contract", () => {
  it("accepts a 4096x4096 output size", () => {
    expect(
      PageExportDocumentDataSchema.safeParse(
        makeDocument({ width: 4096, height: 4096 }),
      ).success,
    ).toBe(true);
  });

  it("rejects an output size above the total pixel budget", () => {
    expect(
      PageExportDocumentDataSchema.safeParse(
        makeDocument({ width: 4096, height: 4097 }),
      ).success,
    ).toBe(false);
  });

  it("rejects an output side above the side budget", () => {
    expect(
      PageExportDocumentDataSchema.safeParse(
        makeDocument({ width: 16_385, height: 1 }),
      ).success,
    ).toBe(false);
  });

  it("keeps logical page geometry independent from actual output raster", () => {
    const document = makeDocument({ width: 836, height: 1200 });
    document.page.width = 1000;
    document.page.height = 1400;

    expect(PageExportDocumentDataSchema.safeParse(document).success).toBe(true);
  });

  it("allows a large source to be safely downscaled", () => {
    const document = makeDocument({ width: 3510, height: 4779 });
    document.sourceSize = { width: 4445, height: 6053 };

    expect(PageExportDocumentDataSchema.safeParse(document).success).toBe(true);
  });

  it("allows original output up to 120 megapixels only", () => {
    const maximum = makeDocument({ width: 10_000, height: 12_000 });
    maximum.resolutionMode = "original";
    maximum.sourceSize = maximum.outputSize;
    expect(PageExportDocumentDataSchema.safeParse(maximum).success).toBe(true);

    const oversized = makeDocument({ width: 10_001, height: 12_000 });
    oversized.resolutionMode = "original";
    oversized.sourceSize = oversized.outputSize;
    expect(PageExportDocumentDataSchema.safeParse(oversized).success).toBe(
      false,
    );
  });
});

function makeDocument(outputSize: { width: number; height: number }) {
  return {
    fontLibrary: {
      customFonts: [],
      preferences: {
        defaultFontId: "default",
        hiddenIds: [],
        favoriteIds: [],
        orderedIds: [],
      },
    },
    imageSrc: "data:image/png;base64,",
    outputSize,
    resolutionMode: "safe-downscale",
    sourceSize: outputSize,
    page: {
      blocks: [],
      height: outputSize.height,
      id: "page-1",
      name: "page.png",
      width: outputSize.width,
    },
  };
}
