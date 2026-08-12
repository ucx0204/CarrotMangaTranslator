import { describe, expect, it } from "vitest";
import type { AppSettings } from "../src/shared/settingsTypes";
import {
  resolveInpaintingGuideHidden,
  withHiddenInpaintingGuide,
} from "../src/renderer/src/app/session/useInpaintingGuidePreference";

describe("inpainting guide preference helpers", () => {
  it("hides the guide when either local storage or settings requests it", () => {
    expect(resolveInpaintingGuideHidden(false, false)).toBe(false);
    expect(resolveInpaintingGuideHidden(true, false)).toBe(true);
    expect(resolveInpaintingGuideHidden(false, true)).toBe(true);
    expect(resolveInpaintingGuideHidden(true, true)).toBe(true);
  });

  it("persists the hidden flag without dropping other UI defaults", () => {
    const settings = {
      ui: {
        blockModeDefault: "keep",
        naturalTextLayoutDefault: false,
      },
    } as AppSettings;

    expect(withHiddenInpaintingGuide(settings).ui).toEqual({
      blockModeDefault: "keep",
      inpaintingGuideHidden: true,
      naturalTextLayoutDefault: false,
    });
  });
});
