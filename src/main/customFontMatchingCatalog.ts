import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  AutomaticFontCandidate,
  AutomaticFontUnicodeRange,
} from "../shared/fontMatchingTypes";
import type { CustomFont, FontLibrarySnapshot } from "../shared/libraryTypes";
import type { UiLocale } from "../shared/uiLocales";
import { SUPPORTED_UI_LOCALES } from "../shared/uiLocales";
import {
  getFontLibrarySnapshot,
  resolveCustomFontFilePath,
} from "./customFonts";
import {
  inspectCustomFontBuffer,
  type CustomFontInspection,
} from "./customFontInspection";
import { getAppPaths } from "./appPaths";

const CACHE_SCHEMA_VERSION = 1;
const ANALYZER_VERSION = 1;
const CACHE_FILE_NAME = "automatic-font-matching.json";
const MAX_INSPECTABLE_FONT_BYTES = 32 * 1024 * 1024;

type CachedInspection = {
  fontId: string;
  fileName: string;
  fileSize: number;
  mtimeMs: number;
  sha256: string;
  analyzerVersion: number;
  inspection: CustomFontInspection;
};

type InspectionCache = {
  schemaVersion: number;
  fonts: CachedInspection[];
};

export type CustomFontMatchingCatalogDependencies = {
  getFontLibrarySnapshot: () => FontLibrarySnapshot;
  resolveCustomFontFilePath: (fontId: string) => string | null;
  getCachePath: () => string;
  reportWarning: (message: string, detail: unknown) => void;
};

const productionDependencies: Omit<
  CustomFontMatchingCatalogDependencies,
  "reportWarning"
> = {
  getFontLibrarySnapshot,
  resolveCustomFontFilePath,
  getCachePath: () => join(getAppPaths().fontsDir, CACHE_FILE_NAME),
};

export function loadCustomFontMatchingCandidates(
  reportWarning: CustomFontMatchingCatalogDependencies["reportWarning"],
): AutomaticFontCandidate[] {
  return loadCustomFontMatchingCandidatesWith({
    ...productionDependencies,
    reportWarning,
  });
}

export function loadCustomFontMatchingCandidatesWith(
  dependencies: CustomFontMatchingCatalogDependencies,
): AutomaticFontCandidate[] {
  const snapshot = dependencies.getFontLibrarySnapshot();
  const cachePath = dependencies.getCachePath();
  const cachedById = new Map(
    readInspectionCache(cachePath).fonts.map((record) => [
      record.fontId,
      record,
    ]),
  );
  const nextRecords: CachedInspection[] = [];
  const orderById = new Map(
    snapshot.preferences.orderedIds.map((id, index) => [id, index] as const),
  );
  const favoriteIds = new Set(snapshot.preferences.favoriteIds);
  const candidates: AutomaticFontCandidate[] = [];

  for (const font of [...snapshot.customFonts].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    try {
      const fontPath = dependencies.resolveCustomFontFilePath(font.id);
      if (!fontPath) {
        continue;
      }
      const record = inspectOrReuseFont(
        font,
        fontPath,
        cachedById.get(font.id),
      );
      nextRecords.push(record);
      candidates.push({
        source: "custom",
        fontId: font.id,
        label: font.label,
        supportedLocales: record.inspection.supportedLocales,
        unicodeRanges: record.inspection.unicodeRanges,
        weight: record.inspection.weight,
        width: record.inspection.width,
        italic: record.inspection.italic,
        serif: record.inspection.serif,
        favorite: favoriteIds.has(font.id),
        defaultFont: snapshot.preferences.defaultFontId === font.id,
        preferenceRank: orderById.get(font.id) ?? Number.MAX_SAFE_INTEGER,
      });
    } catch (error) {
      dependencies.reportWarning("Custom font auto-match inspection failed", {
        fontId: font.id,
        label: font.label,
        error,
      });
    }
  }

  try {
    writeInspectionCacheIfChanged(cachePath, nextRecords, cachedById);
  } catch (error) {
    dependencies.reportWarning("Custom font auto-match cache write failed", {
      cachePath,
      error,
    });
  }
  return candidates;
}

function inspectOrReuseFont(
  font: CustomFont,
  fontPath: string,
  cached: CachedInspection | undefined,
): CachedInspection {
  const stat = statSync(fontPath);
  if (!stat.isFile()) {
    throw new Error("Custom font path is not a file.");
  }
  if (stat.size < 12 || stat.size > MAX_INSPECTABLE_FONT_BYTES) {
    throw new Error("Custom font size is outside the inspection limit.");
  }
  if (
    cached &&
    cached.analyzerVersion === ANALYZER_VERSION &&
    cached.fileName === font.fileName &&
    cached.fileSize === stat.size &&
    cached.mtimeMs === stat.mtimeMs
  ) {
    return cached;
  }
  const buffer = readFileSync(fontPath);
  return {
    fontId: font.id,
    fileName: font.fileName,
    fileSize: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    analyzerVersion: ANALYZER_VERSION,
    inspection: inspectCustomFontBuffer(buffer),
  };
}

function readInspectionCache(path: string): InspectionCache {
  try {
    if (!existsSync(path)) {
      return emptyCache();
    }
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      return emptyCache();
    }
    const data = parsed as Record<string, unknown>;
    if (
      data.schemaVersion !== CACHE_SCHEMA_VERSION ||
      !Array.isArray(data.fonts)
    ) {
      return emptyCache();
    }
    return {
      schemaVersion: CACHE_SCHEMA_VERSION,
      fonts: data.fonts
        .map(normalizeCachedInspection)
        .filter((record): record is CachedInspection => Boolean(record)),
    };
  } catch (_error) {
    return emptyCache();
  }
}

function normalizeCachedInspection(value: unknown): CachedInspection | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const inspection = normalizeInspection(record.inspection);
  if (
    typeof record.fontId !== "string" ||
    typeof record.fileName !== "string" ||
    !isFiniteNonNegative(record.fileSize) ||
    !isFiniteNonNegative(record.mtimeMs) ||
    typeof record.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(record.sha256) ||
    record.analyzerVersion !== ANALYZER_VERSION ||
    !inspection
  ) {
    return null;
  }
  return {
    fontId: record.fontId,
    fileName: record.fileName,
    fileSize: record.fileSize,
    mtimeMs: record.mtimeMs,
    sha256: record.sha256.toLowerCase(),
    analyzerVersion: ANALYZER_VERSION,
    inspection,
  };
}

function normalizeInspection(value: unknown): CustomFontInspection | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const supportedLocales = Array.isArray(record.supportedLocales)
    ? record.supportedLocales.filter(
        (locale): locale is UiLocale =>
          typeof locale === "string" &&
          SUPPORTED_UI_LOCALES.includes(locale as UiLocale),
      )
    : [];
  const unicodeRanges = normalizeUnicodeRanges(record.unicodeRanges);
  if (
    unicodeRanges.length === 0 ||
    !isFiniteInRange(record.weight, 1, 1000) ||
    !isFiniteInRange(record.width, 1, 9) ||
    typeof record.italic !== "boolean" ||
    (record.serif !== undefined && typeof record.serif !== "boolean")
  ) {
    return null;
  }
  return {
    supportedLocales: [...new Set(supportedLocales)],
    unicodeRanges,
    weight: record.weight,
    width: record.width,
    italic: record.italic,
    ...(typeof record.serif === "boolean" ? { serif: record.serif } : {}),
  };
}

function normalizeUnicodeRange(
  value: unknown,
): AutomaticFontUnicodeRange | null {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Number.isInteger(value[0]) ||
    !Number.isInteger(value[1]) ||
    value[0] < 0 ||
    value[0] > value[1] ||
    value[1] > 0x10ffff
  ) {
    return null;
  }
  return [value[0], value[1]];
}

function normalizeUnicodeRanges(value: unknown): AutomaticFontUnicodeRange[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ranges = value.map(normalizeUnicodeRange);
  if (ranges.some((range) => range === null)) {
    return [];
  }
  const sorted = (ranges as AutomaticFontUnicodeRange[]).sort(
    (left, right) => left[0] - right[0] || left[1] - right[1],
  );
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1] + 1) {
      previous[1] = Math.max(previous[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

function writeInspectionCacheIfChanged(
  path: string,
  records: CachedInspection[],
  previousById: ReadonlyMap<string, CachedInspection>,
): void {
  const sorted = [...records].sort((left, right) =>
    left.fontId.localeCompare(right.fontId),
  );
  const previous = [...previousById.values()].sort((left, right) =>
    left.fontId.localeCompare(right.fontId),
  );
  if (JSON.stringify(sorted) === JSON.stringify(previous)) {
    return;
  }
  const payload: InspectionCache = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    fonts: sorted,
  };
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) {
      rmSync(tempPath, { force: true });
    }
  }
}

function emptyCache(): InspectionCache {
  return { schemaVersion: CACHE_SCHEMA_VERSION, fonts: [] };
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFiniteInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}
