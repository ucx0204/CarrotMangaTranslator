import { describe, expect, it } from "vitest";
import { mapCropNormalizedBboxToPageBbox, normalizedRegionToPixelRect } from "../src/shared/region";

describe("region helpers", () => {
  it("converts a normalized selected area to a source pixel crop", () => {
    expect(normalizedRegionToPixelRect({ x: 250, y: 100, w: 500, h: 400 }, { width: 1200, height: 2000 })).toEqual({
      x: 300,
      y: 200,
      w: 600,
      h: 800
    });
  });

  it("maps crop-local normalized boxes back into the original page coordinate space", () => {
    expect(
      mapCropNormalizedBboxToPageBbox(
        { x: 300, y: 200, w: 600, h: 800 },
        { width: 1200, height: 2000 },
        { x: 100, y: 250, w: 500, h: 500 }
      )
    ).toEqual({
      x: 300,
      y: 200,
      w: 250,
      h: 200
    });
  });
});
