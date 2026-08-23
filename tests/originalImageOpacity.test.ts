import { describe, expect, it } from "vitest";
import {
  clampOriginalImageOpacity,
  isOriginalImageOpacityAvailable,
} from "../src/renderer/src/lib/originalImageOpacity";

const readyInput = {
  selectedPage: {
    id: "page-1",
    imagePath: "original.png",
    inpaintedImagePath: "inpainted.png",
  },
  selectedPageImageDataUrl: "data:image/png;base64,inpainted",
  selectedPageImageDataUrlPageId: "page-1",
  selectedPageOriginalImageDataUrl: "data:image/png;base64,original",
  selectedPageOriginalImageDataUrlPageId: "page-1",
};

describe("original image opacity availability", () => {
  it("clamps invalid session values to a render-safe opacity", () => {
    expect(clampOriginalImageOpacity(-1)).toBe(0);
    expect(clampOriginalImageOpacity(0.42)).toBe(0.42);
    expect(clampOriginalImageOpacity(2)).toBe(1);
    expect(clampOriginalImageOpacity(Number.NaN)).toBe(0);
  });

  it("requires a distinct inpainted image and two ready frames", () => {
    expect(isOriginalImageOpacityAvailable(readyInput)).toBe(true);
    expect(
      isOriginalImageOpacityAvailable({
        ...readyInput,
        selectedPage: {
          ...readyInput.selectedPage,
          inpaintedImagePath: undefined,
        },
      }),
    ).toBe(false);
    expect(
      isOriginalImageOpacityAvailable({
        ...readyInput,
        selectedPage: {
          ...readyInput.selectedPage,
          inpaintedImagePath: readyInput.selectedPage.imagePath,
        },
      }),
    ).toBe(false);
    expect(
      isOriginalImageOpacityAvailable({
        ...readyInput,
        selectedPageOriginalImageDataUrl: readyInput.selectedPageImageDataUrl,
      }),
    ).toBe(false);
  });

  it("rejects stale frames from a previously selected page", () => {
    expect(
      isOriginalImageOpacityAvailable({
        ...readyInput,
        selectedPageImageDataUrlPageId: "page-0",
      }),
    ).toBe(false);
    expect(
      isOriginalImageOpacityAvailable({
        ...readyInput,
        selectedPageOriginalImageDataUrlPageId: "page-0",
      }),
    ).toBe(false);
    expect(
      isOriginalImageOpacityAvailable({
        ...readyInput,
        selectedPageOriginalImageDataUrl: "",
      }),
    ).toBe(false);
  });
});
