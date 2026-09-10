import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import { APP_I18N_RESOURCES } from "../src/shared/i18n/resources";
import { SUPPORTED_UI_LOCALES } from "../src/shared/uiLocales";

const reference = APP_I18N_RESOURCES.ko.components.manualRedaction;
const placeholders = (value: string) =>
  [...value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)]
    .map((match) => match[1])
    .sort();

describe("manual redaction locale contract", () => {
  it.each(SUPPORTED_UI_LOCALES)(
    "has every key and interpolation variable in %s",
    (locale) => {
      const messages = APP_I18N_RESOURCES[locale].components.manualRedaction;
      expect(Object.keys(messages).sort()).toEqual(
        Object.keys(reference).sort(),
      );
      for (const key of Object.keys(reference) as Array<
        keyof typeof reference
      >) {
        expect(messages[key].trim(), `${locale}.${key}`).not.toBe("");
        expect(placeholders(messages[key]), `${locale}.${key}`).toEqual(
          placeholders(reference[key]),
        );
      }
    },
  );

  it.each(SUPPORTED_UI_LOCALES)(
    "renders its own messages without fallback in %s",
    async (locale) => {
      const i18n = createInstance();
      await i18n.init({
        lng: locale,
        fallbackLng: false,
        resources: { [locale]: APP_I18N_RESOURCES[locale] },
        defaultNS: "components",
        interpolation: { escapeValue: false },
      });
      expect(i18n.t("manualRedaction.title")).toBe(
        APP_I18N_RESOURCES[locale].components.manualRedaction.title,
      );
      const progress = i18n.t("manualRedaction.progress", {
        count: 7,
        total: 100,
      });
      expect(progress).toContain("7");
      expect(progress).toContain("100");
      expect(progress).not.toMatch(/\{\{|manualRedaction/);
    },
  );
});
