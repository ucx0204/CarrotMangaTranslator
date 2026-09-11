import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { APP_I18N_RESOURCES } from "../src/shared/i18n/resources";
import { SUPPORTED_UI_LOCALES, type UiLocale } from "../src/shared/uiLocales";

const ROOT = process.cwd();
type Namespace = keyof (typeof APP_I18N_RESOURCES)["ko"];

describe("i18n key usage", () => {
  it("resolves typed translators per function without treating missing keys as valid", () => {
    const source = `
      function components(t: TFunction<"components">) { t("manualRedaction.preparationHint"); }
      function renderer(t: TFunction<"renderer">) { t("missing.key"); }
      function view() { t("statusDock.open"); }
    `;
    const scopes = typedTranslatorScopes(source);
    const at = (key: string) =>
      literalTranslatorNamespace(
        scopes,
        source.indexOf(`t("${key}")`),
        "components",
      );
    expect(at("manualRedaction.preparationHint")).toBe("components");
    expect(at("missing.key")).toBe("renderer");
    expect(at("statusDock.open")).toBe("components");
    expect(
      catalogKeys(at("manualRedaction.preparationHint"), "ko").has(
        "manualRedaction.preparationHint",
      ),
    ).toBe(true);
    expect(catalogKeys(at("missing.key"), "ko").has("missing.key")).toBe(false);
  });
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
      const componentFiles = sourceFiles(
        join(ROOT, "src", "renderer", "src", "components"),
      );
      const rendererFiles = sourceFiles(
        join(ROOT, "src", "renderer", "src"),
      ).filter(
        (file) => !componentFiles.includes(file) && !file.endsWith("i18n.tsx"),
      );
      expectMissingKeys(componentFiles, "components", locale, [
        /\bt\(\s*["']([^"']+)["']/g,
        /\btranslate\(\s*t\s*,\s*["']([^"']+)["']/g,
      ]);
      expectMissingKeys(rendererFiles, "renderer", locale, [
        /\bt\(\s*["']([^"']+)["']/g,
        /\btranslate\(\s*t\s*,\s*["']([^"']+)["']/g,
      ]);
      expectMissingKeys(
        [join(ROOT, "src", "renderer", "src", "i18n.tsx")],
        "common",
        locale,
        [/\bappI18n\.t\(\s*["']([^"']+)["']/g],
      );
    },
  );

  it.each(SUPPORTED_UI_LOCALES)(
    "has catalog entries for main-process translation calls in %s",
    (locale) => {
      const files = sourceFiles(join(ROOT, "src", "main"));
      expectMissingKeys(files, "main", locale, [
        /\btMain\(\s*["']([^"']+)["']/g,
      ]);
      expectMissingKeys(files, "common", locale, [
        /\btMainCommon\(\s*["']([^"']+)["']/g,
      ]);
    },
  );
});

function expectMissingKeys(
  files: string[],
  fallback: Namespace,
  locale: UiLocale,
  patterns: RegExp[],
): void {
  const missing: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const scopes = typedTranslatorScopes(source);
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const namespace = literalTranslatorNamespace(
          scopes,
          match.index,
          fallback,
        );
        const knownKeys = catalogKeys(namespace, locale);
        const key = match[1];
        if (key && !knownKeys.has(key)) {
          missing.push(`${relativeSourcePath(file)}: ${key}`);
        }
      }
    }
  }
  expect(missing).toEqual([]);
}

type TranslatorScope = { start: number; end: number; namespace?: Namespace };

function typedTranslatorScopes(source: string): TranslatorScope[] {
  if (!source.includes("TFunction")) return [];
  const file = ts.createSourceFile(
    "source.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const scopes: TranslatorScope[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) {
      const translator = node.parameters.find(
        (parameter) =>
          ts.isIdentifier(parameter.name) && parameter.name.text === "t",
      );
      if (translator) {
        const type = translator.type;
        const argument =
          type &&
          ts.isTypeReferenceNode(type) &&
          type.typeName.getText(file) === "TFunction"
            ? type.typeArguments?.[0]
            : undefined;
        const namespace =
          argument &&
          ts.isLiteralTypeNode(argument) &&
          ts.isStringLiteral(argument.literal)
            ? argument.literal.text
            : undefined;
        scopes.push({
          start: node.getStart(file),
          end: node.end,
          namespace:
            namespace && Object.hasOwn(APP_I18N_RESOURCES.ko, namespace)
              ? (namespace as Namespace)
              : undefined,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return scopes.sort((a, b) => a.end - a.start - (b.end - b.start));
}

function literalTranslatorNamespace(
  scopes: TranslatorScope[],
  position: number,
  fallback: Namespace,
): Namespace {
  // The nearest injected t owns its namespace; another helper cannot rebind the file.
  return (
    scopes.find(({ start, end }) => start <= position && position < end)
      ?.namespace ?? fallback
  );
}

const catalogs = new Map<string, Set<string>>();

function catalogKeys(namespace: Namespace, locale: UiLocale): Set<string> {
  // Use the exact composed catalog consumed by the app, including split modules.
  const key = `${locale}:${namespace}`;
  let keys = catalogs.get(key);
  if (!keys) {
    keys = new Set(flattenCatalog(APP_I18N_RESOURCES[locale][namespace]));
    catalogs.set(key, keys);
  }
  return keys;
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
