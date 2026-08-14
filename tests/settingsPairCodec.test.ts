import { describe, expect, it } from "vitest";
import {
  assertSettingsGeneration,
  isSettingsGeneration,
  isSettingsJsonRecord,
  parseSettingsJsonRecord,
  serializeSettingsJson,
} from "../src/main/settingsPairCodec";

describe("settings pair codec", () => {
  it("keeps the pretty JSON object codec byte-stable", () => {
    const payload = { version: 1, nested: { enabled: true } };
    const encoded = serializeSettingsJson(payload);

    expect(encoded).toBe(
      '{\n  "version": 1,\n  "nested": {\n    "enabled": true\n  }\n}\n',
    );
    expect(parseSettingsJsonRecord(encoded, "Settings fixture")).toEqual(
      payload,
    );
  });

  it("distinguishes malformed JSON from non-object JSON", () => {
    expect(() => parseSettingsJsonRecord("{", "Settings fixture")).toThrow(
      SyntaxError,
    );
    expect(() => parseSettingsJsonRecord("[]", "Settings fixture")).toThrow(
      "Settings fixture must contain a JSON object.",
    );
    expect(isSettingsJsonRecord({})).toBe(true);
    expect(isSettingsJsonRecord(null)).toBe(false);
  });

  it("accepts only UUID v4 settings generations", () => {
    const valid = "123e4567-e89b-42d3-a456-426614174000";
    expect(isSettingsGeneration(valid)).toBe(true);
    expect(() => assertSettingsGeneration(valid)).not.toThrow();

    for (const invalid of [
      "",
      "123e4567-e89b-12d3-a456-426614174000",
      "123e4567-e89b-42d3-7456-426614174000",
    ]) {
      expect(isSettingsGeneration(invalid)).toBe(false);
      expect(() => assertSettingsGeneration(invalid)).toThrow(
        "Settings generation identifier is invalid.",
      );
    }
  });
});
