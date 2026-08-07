import { describe, expect, it } from "vitest";
import { assertDecodedPageExportImageSize } from "../src/renderer/src/pageExport/rasterValidation";

describe("page export renderer raster validation", () => {
  it("accepts an exact bounded natural-size match", () => {
    expect(() =>
      assertDecodedPageExportImageSize(
        { width: 2048, height: 8192 },
        { width: 2048, height: 8192 },
      ),
    ).not.toThrow();
  });

  it("rejects a natural-size mismatch", () => {
    expect(() =>
      assertDecodedPageExportImageSize(
        { width: 1000, height: 1999 },
        { width: 1000, height: 2000 },
      ),
    ).toThrow(/dimensions changed/i);
  });

  it("rejects an unsafe natural size", () => {
    expect(() =>
      assertDecodedPageExportImageSize(
        { width: 5000, height: 12000 },
        { width: 5000, height: 12000 },
      ),
    ).toThrow(/raster safety budget/i);
  });
});
