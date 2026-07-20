import { describe, expect, it } from "vitest";
import {
  parseStoredAppSettings,
  resolveDefaultAppSettings,
} from "../src/main/appSettings";
import { AppSettingsSchema } from "../src/shared/ipcSettingsSchemas";

describe("speech bubble detection settings", () => {
  it("defaults to auto and restores precise and highest-quality modes", () => {
    const defaults = resolveDefaultAppSettings();
    const precise = parseStoredAppSettings(
      '{"inpainting":{"bubbleDetectionMode":"precise"}}',
      defaults,
    );
    const quality = parseStoredAppSettings(
      '{"inpainting":{"bubbleDetectionMode":"quality"}}',
      defaults,
    );
    const sam3 = parseStoredAppSettings(
      '{"inpainting":{"bubbleDetectionMode":"sam3-experimental"}}',
      defaults,
    );

    expect(defaults.inpainting?.bubbleDetectionMode).toBe("auto");
    expect(precise.inpainting?.bubbleDetectionMode).toBe("precise");
    expect(
      AppSettingsSchema.parse(precise).inpainting?.bubbleDetectionMode,
    ).toBe("precise");
    expect(quality.inpainting?.bubbleDetectionMode).toBe("quality");
    expect(sam3.inpainting?.bubbleDetectionMode).toBe("sam3-experimental");
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
