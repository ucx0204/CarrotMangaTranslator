import { beforeAll, describe, expect, it } from "vitest";
import { APP_I18N_RESOURCES } from "../src/shared/i18n/resources";
import { SUPPORTED_UI_LOCALES } from "../src/shared/uiLocales";
import { JobKindSchema, JobStatusSchema } from "../src/shared/jobContracts";
import {
  OCR_PIPELINES,
  resolveOcrRendererKeyPrefix,
} from "../src/shared/ocrEngines";
import { RESIZE_DIRECTIONS } from "../src/shared/regionSelectionGeometry";
import {
  auditTranslationSources,
  type TranslationAudit,
} from "./testUtils/i18nSourceAudit";

type Namespace = keyof typeof APP_I18N_RESOURCES.ko;
function keysOf(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return [prefix];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    keysOf(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("dynamic and registered translation keys", () => {
  let audit: TranslationAudit;
  beforeAll(() => {
    audit = auditTranslationSources(process.cwd());
  }, 60_000);
  it.each(SUPPORTED_UI_LOCALES)(
    "resolves finite source expressions and option registries in %s",
    (locale) => {
      const catalogs = Object.fromEntries(
        Object.entries(APP_I18N_RESOURCES[locale]).map(([ns, value]) => [
          ns,
          new Set(keysOf(value)),
        ]),
      ) as Record<Namespace, Set<string>>;
      const missing: string[] = [];
      for (const use of audit.uses) {
        for (const raw of use.keys) {
          const [namespace, key] = raw.includes(":")
            ? raw.split(":")
            : [use.namespace, raw];
          const candidates = namespace
            ? [catalogs[namespace as Namespace]]
            : Object.values(catalogs);
          if (!candidates.some((catalog) => catalog?.has(key)))
            missing.push(
              `${use.file}:${use.line}: ${namespace ?? "registry"}:${key}`,
            );
        }
      }
      expect(audit.calls).toBeGreaterThan(2500);
      expect(missing).toEqual([]);
    },
  );
  it.each(SUPPORTED_UI_LOCALES)(
    "covers persisted job history and computed resize labels in %s",
    (locale) => {
      const catalog = new Set(keysOf(APP_I18N_RESOURCES[locale].components));
      const expected = [
        ...JobKindSchema.options.map(
          (kind) => `statusDock.history.kind.${kind}`,
        ),
        ...JobStatusSchema.options.map(
          (status) => `statusDock.history.status.${status}`,
        ),
        ...RESIZE_DIRECTIONS.map(
          (direction) =>
            `transform.handles.resize${direction[0].toUpperCase()}${direction.slice(1)}`,
        ),
        ...["start", "center", "end"].map(
          (alignment) => `transform.curve.align.${alignment}`,
        ),
        ...["tangent", "upright"].map(
          (orientation) => `transform.curve.orientations.${orientation}`,
        ),
        "styleGuide.glossary.categories.sfx",
      ];
      expect(expected.filter((key) => !catalog.has(key))).toEqual([]);
    },
  );
  it.each(SUPPORTED_UI_LOCALES)(
    "resolves assembled OCR phase names in %s",
    (locale) => {
      const catalog = new Set(keysOf(APP_I18N_RESOURCES[locale].renderer));
      const expected = OCR_PIPELINES.flatMap((pipeline) =>
        ["Downloading", "Preparing", "Running"].map(
          (suffix) =>
            `job.phase.${resolveOcrRendererKeyPrefix(pipeline)}${suffix}`,
        ),
      );
      expect(expected.filter((key) => !catalog.has(key))).toEqual([]);
    },
  );
});
