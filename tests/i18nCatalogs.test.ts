import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SUPPORTED_UI_LOCALES } from "../src/shared/uiLocales";

const LOCALES_ROOT = join(process.cwd(), "src", "shared", "i18n", "locales");

describe("i18n catalogs", () => {
  const namespaces = readdirSync(join(LOCALES_ROOT, "ko"))
    .filter((name) => name.endsWith(".json"))
    .sort();

  it("has at least one namespace", () => {
    expect(namespaces.length).toBeGreaterThan(0);
  });

  for (const namespace of namespaces) {
    it(`${namespace} has matching keys and interpolation variables`, () => {
      const reference = readCatalog("ko", namespace);
      const referenceEntries = flattenCatalog(reference);
      for (const locale of SUPPORTED_UI_LOCALES) {
        const candidateEntries = flattenCatalog(readCatalog(locale, namespace));
        expect(Object.keys(candidateEntries).sort(), locale).toEqual(
          Object.keys(referenceEntries).sort(),
        );
        for (const [key, referenceValue] of Object.entries(referenceEntries)) {
          const candidateValue = candidateEntries[key];
          expect(
            candidateValue?.trim().length,
            `${locale}:${namespace}:${key}`,
          ).toBeGreaterThan(0);
          expect(
            interpolationNames(candidateValue),
            `${locale}:${namespace}:${key}`,
          ).toEqual(interpolationNames(referenceValue));
        }
      }
    });
  }
});

function readCatalog(locale: string, namespace: string): unknown {
  return JSON.parse(
    readFileSync(join(LOCALES_ROOT, locale, namespace), "utf8"),
  ) as unknown;
}

function flattenCatalog(
  value: unknown,
  prefix = "",
  output: Record<string, string> = {},
): Record<string, string> {
  if (typeof value === "string") {
    output[prefix] = value;
    return output;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Catalog value at ${prefix || "<root>"} must be an object or string.`,
    );
  }
  for (const [key, child] of Object.entries(value)) {
    flattenCatalog(child, prefix ? `${prefix}.${key}` : key, output);
  }
  return output;
}

function interpolationNames(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}/g)]
    .map((match) => match[1])
    .sort();
}
