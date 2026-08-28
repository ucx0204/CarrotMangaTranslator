import { describe, expect, it } from "vitest";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import { MAX_API_KEYS } from "../src/shared/apiKeySettings";
import { AppSettingsSchema } from "../src/shared/ipcSettingsSchemas";

describe("masked API key count settings metadata", () => {
  it("accepts a bounded count for renderer round-trips", () => {
    const settings = resolveDefaultAppSettings();
    const parsed = AppSettingsSchema.parse({
      ...settings,
      api: { ...settings.api, apiKeyCount: 3 },
    });

    expect(parsed.api.apiKeyCount).toBe(3);
  });

  it("rejects a count above the supported API key limit", () => {
    const settings = resolveDefaultAppSettings();

    expect(() =>
      AppSettingsSchema.parse({
        ...settings,
        api: { ...settings.api, apiKeyCount: MAX_API_KEYS + 1 },
      }),
    ).toThrow();
  });
});
