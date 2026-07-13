import { describe, expect, it } from "vitest";
import {
  normalizeApiKeysText,
  parseApiKeys,
} from "../src/shared/apiKeySettings";
import { parseStoredAppSettings } from "../src/main/appSettings";

describe("multi-key API settings", () => {
  it("trims blank lines and removes duplicate keys without changing order", () => {
    expect(parseApiKeys(" first \r\n\nsecond\nfirst\n third ")).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(normalizeApiKeysText(" first \nsecond\nfirst ")).toBe(
      "first\nsecond",
    );
  });

  it("normalizes retry limits and preserves newline-separated keys", () => {
    const settings = parseStoredAppSettings(
      JSON.stringify({
        api: {
          baseUrl: "https://openrouter.ai/api/v1",
          model: "vendor/vision",
          apiKey: " key-a \nkey-b\nkey-a",
          keyMaxAttempts: 999,
          retryDelaySeconds: -4,
        },
      }),
    );

    expect(settings.api.apiKey).toBe("key-a\nkey-b");
    expect(settings.api.keyMaxAttempts).toBe(20);
    expect(settings.api.retryDelaySeconds).toBe(0);
  });
});
