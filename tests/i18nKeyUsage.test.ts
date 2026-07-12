import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const LOCALE_ROOT = join(ROOT, "src", "shared", "i18n", "locales", "ko");

describe("i18n key usage", () => {
  it("has catalog entries for literal renderer translation calls", () => {
    const componentKeys = catalogKeys("components.json");
    const rendererKeys = catalogKeys("renderer.json");
    const commonKeys = catalogKeys("common.json");
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
  });

  it("has catalog entries for main-process translation calls", () => {
    const mainKeys = catalogKeys("main.json");
    const commonKeys = catalogKeys("common.json");
    const files = sourceFiles(join(ROOT, "src", "main"));
    expectMissingKeys(files, mainKeys, [/\btMain\(\s*["']([^"']+)["']/g]);
    expectMissingKeys(files, commonKeys, [
      /\btMainCommon\(\s*["']([^"']+)["']/g,
    ]);
  });
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

function catalogKeys(fileName: string): Set<string> {
  const value = JSON.parse(readFileSync(join(LOCALE_ROOT, fileName), "utf8"));
  return new Set(flattenCatalog(value));
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
