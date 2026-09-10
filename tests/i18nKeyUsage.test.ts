import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_I18N_RESOURCES } from "../src/shared/i18n/resources";
import { SUPPORTED_UI_LOCALES, type UiLocale } from "../src/shared/uiLocales";

const ROOT = process.cwd();
type Namespace = keyof (typeof APP_I18N_RESOURCES)["ko"];

describe("i18n key usage", () => {
  it("does not mistake object names or non-string values for translation keys", () => {
    expect(
      flattenCatalog({
        label: "Text",
        nested: { title: "Title", empty: {} },
        number: 1,
        missing: null,
        list: ["Not a translation"],
      }),
    ).toEqual(["label", "nested.title"]);
  });

  it.each(SUPPORTED_UI_LOCALES)(
    "has catalog entries for literal renderer translation calls in %s",
    (locale) => {
      const componentKeys = catalogKeys("components", locale);
      const rendererKeys = catalogKeys("renderer", locale);
      const commonKeys = catalogKeys("common", locale);
      const componentFiles = sourceFiles(
        join(ROOT, "src", "renderer", "src", "components"),
      );
      const rendererFiles = sourceFiles(
        join(ROOT, "src", "renderer", "src"),
      ).filter(
        (file) => !componentFiles.includes(file) && !file.endsWith("i18n.tsx"),
      );
      expectMissingKeys(componentFiles, componentKeys, [
        /\bt\(\s*["']([^"']+)["']/g,
        /\btranslate\(\s*t\s*,\s*["']([^"']+)["']/g,
      ]);
      expectMissingKeys(rendererFiles, rendererKeys, [
        /\bt\(\s*["']([^"']+)["']/g,
        /\btranslate\(\s*t\s*,\s*["']([^"']+)["']/g,
      ]);
      expectMissingKeys(
        [join(ROOT, "src", "renderer", "src", "i18n.tsx")],
        commonKeys,
        [/\bappI18n\.t\(\s*["']([^"']+)["']/g],
      );
    },
  );

  it.each(SUPPORTED_UI_LOCALES)(
    "has catalog entries for main-process translation calls in %s",
    (locale) => {
      const mainKeys = catalogKeys("main", locale);
      const commonKeys = catalogKeys("common", locale);
      const files = sourceFiles(join(ROOT, "src", "main"));
      expectMissingKeys(files, mainKeys, [/\btMain\(\s*["']([^"']+)["']/g]);
      expectMissingKeys(files, commonKeys, [
        /\btMainCommon\(\s*["']([^"']+)["']/g,
      ]);
    },
  );
});

function expectMissingKeys(
  files: string[],
  knownKeys: Set<string>,
  patterns: RegExp[],
): void {
  const missing: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const key = match[1];
        if (key && !knownKeys.has(key)) {
          missing.push(`${relativeSourcePath(file)}: ${key}`);
        }
      }
    }
  }
  expect(missing).toEqual([]);
}

function catalogKeys(namespace: Namespace, locale: UiLocale): Set<string> {
  // Use the exact composed catalog consumed by the app, including split modules.
  // A JSON fragment is not the complete runtime namespace.
  return new Set(flattenCatalog(APP_I18N_RESOURCES[locale][namespace]));
}

function flattenCatalog(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") {
    return [prefix];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    flattenCatalog(child, prefix ? `${prefix}.${key}` : key),
  );
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (/\.(?:ts|tsx)$/.test(name)) {
      files.push(path);
    }
  }
  return files;
}

function relativeSourcePath(file: string): string {
  return file.slice(ROOT.length + 1).replaceAll("\\", "/");
}
