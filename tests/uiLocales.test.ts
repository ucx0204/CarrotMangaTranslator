import { describe, expect, it } from "vitest";
import {
  DEFAULT_UI_LOCALE,
  normalizeUiLocale,
  resolveUiLocale,
  SUPPORTED_UI_LOCALES,
} from "../src/shared/uiLocales";
import {
  parseStoredAppSettings,
  resolveDefaultAppSettings,
} from "../src/main/appSettings";
import { AppSettingsSchema } from "../src/shared/ipcSettingsSchemas";

describe("UI locales", () => {
  it("supports Korean, Japanese, English, and both Chinese scripts", () => {
    expect(SUPPORTED_UI_LOCALES).toEqual([
      "ko",
      "ja",
      "en",
      "zh-Hans",
      "zh-Hant",
    ]);
  });

  it.each([
    ["ko-KR", "ko"],
    ["ja-JP", "ja"],
    ["en-US", "en"],
    ["zh-CN", "zh-Hans"],
    ["zh-SG", "zh-Hans"],
    ["zh-TW", "zh-Hant"],
    ["zh-HK", "zh-Hant"],
    ["zh-Hant", "zh-Hant"],
  ] as const)("maps system locale %s to %s", (input, expected) => {
    expect(resolveUiLocale(input)).toBe(expected);
  });

  it("falls back to Korean for unsupported or invalid values", () => {
    expect(normalizeUiLocale("fr-FR")).toBe(DEFAULT_UI_LOCALE);
    expect(normalizeUiLocale(null)).toBe(DEFAULT_UI_LOCALE);
  });

  it("uses the system locale environment as the default", () => {
    expect(
      resolveDefaultAppSettings({ MANGA_TRANSLATOR_UI_LOCALE: "ja-JP" }).ui
        ?.locale,
    ).toBe("ja");
    expect(
      resolveDefaultAppSettings({ MANGA_TRANSLATOR_UI_LOCALE: "zh-TW" }).ui
        ?.locale,
    ).toBe("zh-Hant");
  });

  it("backfills missing and invalid stored locale from the system default", () => {
    const defaults = resolveDefaultAppSettings({
      MANGA_TRANSLATOR_UI_LOCALE: "en-US",
    });
    expect(parseStoredAppSettings("{}", defaults).ui?.locale).toBe("en");
    expect(
      parseStoredAppSettings('{"ui":{"locale":"invalid"}}', defaults).ui
        ?.locale,
    ).toBe("en");
  });

  it("accepts supported locales over IPC and rejects unsupported locales", () => {
    const settings = resolveDefaultAppSettings({
      MANGA_TRANSLATOR_UI_LOCALE: "ko-KR",
    });
    expect(AppSettingsSchema.safeParse(settings).success).toBe(true);
    expect(
      AppSettingsSchema.safeParse({
        ...settings,
        ui: { ...settings.ui, locale: "fr" },
      }).success,
    ).toBe(false);
  });
});
