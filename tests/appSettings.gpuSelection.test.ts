import { describe, expect, it } from "vitest";
import {
  normalizeAppSettings,
  parseStoredAppSettings,
  resolveDefaultAppSettings,
} from "../src/main/appSettings";
import { AppSettingsSchema } from "../src/shared/ipcSettingsSchemas";

describe("app settings GPU selection", () => {
  it("accepts only supported graphics preferences and compute GPU indices", () => {
    const defaults = resolveDefaultAppSettings({});

    for (const hardware of [
      undefined,
      { graphicsGpuPreference: "auto" },
      { graphicsGpuPreference: "high-performance", computeGpuIndex: 0 },
      { computeGpuIndex: 15 },
    ]) {
      const payload =
        hardware === undefined
          ? { ...defaults, hardware: undefined }
          : { ...defaults, hardware };
      expect(
        AppSettingsSchema.safeParse(payload).success,
        JSON.stringify(hardware),
      ).toBe(true);
    }

    for (const hardware of [
      { graphicsGpuPreference: "power-saving" },
      { computeGpuIndex: -1 },
      { computeGpuIndex: 16 },
      { computeGpuIndex: 1.5 },
      { computeGpuIndex: null },
      { computeGpuIndex: "1" },
    ]) {
      expect(
        AppSettingsSchema.safeParse({ ...defaults, hardware }).success,
        JSON.stringify(hardware),
      ).toBe(false);
    }
  });

  it("defaults and migrates missing GPU preferences to automatic selection", () => {
    const defaults = resolveDefaultAppSettings({});

    expect(defaults.hardware).toEqual({
      graphicsGpuPreference: "auto",
    });
    expect(normalizeAppSettings({}, defaults).hardware).toEqual({
      graphicsGpuPreference: "auto",
    });
    expect(parseStoredAppSettings("{}", defaults).hardware).toEqual({
      graphicsGpuPreference: "auto",
    });
  });

  it("preserves explicit compute GPU indices 0 and 1 through normalization", () => {
    const defaults = resolveDefaultAppSettings({});

    expect(
      normalizeAppSettings(
        {
          hardware: {
            graphicsGpuPreference: "high-performance",
            computeGpuIndex: 0,
          },
        },
        defaults,
      ).hardware,
    ).toEqual({
      graphicsGpuPreference: "high-performance",
      computeGpuIndex: 0,
    });
    expect(
      parseStoredAppSettings(
        JSON.stringify({
          hardware: {
            graphicsGpuPreference: "auto",
            computeGpuIndex: 1,
          },
        }),
        defaults,
      ).hardware,
    ).toEqual({
      graphicsGpuPreference: "auto",
      computeGpuIndex: 1,
    });
  });

  it("does not coerce malformed boolean GPU indices to 0 or 1", () => {
    const defaults = resolveDefaultAppSettings({});

    for (const computeGpuIndex of [false, true]) {
      expect(
        normalizeAppSettings(
          {
            hardware: {
              graphicsGpuPreference: "auto",
              computeGpuIndex,
            },
          },
          defaults,
        ).hardware,
      ).toEqual({
        graphicsGpuPreference: "auto",
      });
    }
  });
});
