import { describe, expect, it } from "vitest";
import {
  mapCropNormalizedBboxToPageBbox,
  normalizedRegionToPixelRect,
} from "../src/shared/region";

describe("region helpers", () => {
  it("retains a planned transparent foreground canvas beyond the crop while source boxes stay clipped", () => {
    const crop = { x: 300, y: 200, w: 600, h: 800 },
      page = { width: 1200, height: 2000 };
    const box = { x: -100, y: -250, w: 1200, h: 1500 };
    expect(mapCropNormalizedBboxToPageBbox(crop, page, box, true)).toEqual({
      x: 200,
      y: 0,
      w: 600,
      h: 600,
    });
    expect(mapCropNormalizedBboxToPageBbox(crop, page, box)).toEqual({
      x: 250,
      y: 100,
      w: 500,
      h: 400,
    });
  });
  it("converts a normalized selected area to a source pixel crop", () => {
    expect(
      normalizedRegionToPixelRect(
        { x: 250, y: 100, w: 500, h: 400 },
        { width: 1200, height: 2000 },
      ),
    ).toEqual({
      x: 300,
      y: 200,
      w: 600,
      h: 800,
    });
  });

  it("maps crop-local normalized boxes back into the original page coordinate space", () => {
    expect(
      mapCropNormalizedBboxToPageBbox(
        { x: 300, y: 200, w: 600, h: 800 },
        { width: 1200, height: 2000 },
        { x: 100, y: 250, w: 500, h: 500 },
      ),
    ).toEqual({
      x: 300,
      y: 200,
      w: 250,
      h: 200,
    });
  });
});
