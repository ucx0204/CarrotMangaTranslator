import { describe, expect, it } from "vitest";
import {
  parseStoredAppSettings,
  resolveDefaultAppSettings,
} from "../src/main/appSettings";
import { AppSettingsSchema } from "../src/shared/ipcSettingsSchemas";

describe("speech bubble detection settings", () => {
  it("defaults to auto and restores precise mode", () => {
    const defaults = resolveDefaultAppSettings();
    const precise = parseStoredAppSettings(
      '{"inpainting":{"bubbleDetectionMode":"precise"}}',
      defaults,
    );

    expect(defaults.inpainting?.bubbleDetectionMode).toBe("auto");
    expect(precise.inpainting?.bubbleDetectionMode).toBe("precise");
    expect(
      AppSettingsSchema.parse(precise).inpainting?.bubbleDetectionMode,
    ).toBe("precise");
  });

  it("falls back to auto for an unknown stored value", () => {
    const defaults = resolveDefaultAppSettings();
    const restored = parseStoredAppSettings(
      '{"inpainting":{"bubbleDetectionMode":"unknown"}}',
      defaults,
    );

    expect(restored.inpainting?.bubbleDetectionMode).toBe("auto");
  });
});
