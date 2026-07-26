import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TranslationOptions } from "../appSettings";
import type { ChapterRunPaths } from "../library";
import type { MangaPage } from "../../shared/libraryTypes";
import {
  DEFAULT_SOURCE_LANGUAGE,
  normalizeLanguageCode,
} from "../../shared/translationLanguages";
import {
  buildOcrCacheConfiguration,
  matchesOcrCacheConfiguration,
} from "./ocrHintsCacheConfiguration";
import type { OcrBboxResult } from "./types";

// Schema 10 refreshes Anime YOLO evidence after evidence selection gained the
// conservative confirmed-fragment separation barrier. Schema 9 already has
// the current axis-v4 OCR/grouping metadata, so it can be upgraded by rerunning
// only the optional grouping-evidence pass instead of expensive Paddle OCR.
const OCR_HINT_CACHE_SCHEMA_VERSION = 10;
const GROUPING_EVIDENCE_MIGRATION_SCHEMA_VERSION = 9;
const ANIME_TEXT_EVIDENCE_KEYS = [
  "animeTextRegionId",
  "animeTextRegionScore",
  "animeTextContainment",
  "animeTextRegionBbox",
  "animeTextEvidenceVersion",
  "animeTextModelRevision",
] as const;

export type CachedOcrHints = {
  schemaVersion: number;
  result: OcrBboxResult;
  requiresGroupingEvidenceRefresh: boolean;
};

type RawCachedOcrHints = {
  schemaVersion?: number;
  imagePath?: string;
  width?: number;
  height?: number;
  sourceLanguage?: string;
  configuration?: unknown;
  hints?: unknown[];
  diagnostics?: unknown[];
  noTextDetected?: boolean;
  textEvidenceCount?: number;
  groupingEvidence?: unknown;
};

export function buildOcrPageOptions(
  baseOptions: TranslationOptions,
  page: MangaPage,
  runPaths: ChapterRunPaths,
  index: number,
  total: number,
): TranslationOptions {
  return {
    ...baseOptions,
    imagePath: page.imagePath,
    imageWidth: page.width,
    imageHeight: page.height,
    outputDir: getOcrHintsOutputDir(runPaths, page),
    label: `ocr-page-${index + 1}`,
    ocrPageIndex: index + 1,
    ocrPageTotal: total,
    ocrProgressDefaultToPage: true,
  };
}

export function getOcrHintsCachePath(
  runPaths: ChapterRunPaths,
  page: MangaPage,
): string {
  return join(getOcrHintsOutputDir(runPaths, page), "result.json");
}

export async function readCachedOcrHints(
  cachePath: string,
  page: MangaPage,
  options: TranslationOptions,
): Promise<CachedOcrHints | null> {
  try {
    const raw = JSON.parse(
      await readFile(cachePath, "utf8"),
    ) as RawCachedOcrHints;
    return isCompatibleCachedOcrHints(raw, page, options)
      ? buildCachedOcrHints(raw)
      : null;
  } catch (_error) {
    return null;
  }
}

function isCompatibleCachedOcrHints(
  raw: RawCachedOcrHints,
  page: MangaPage,
  options: TranslationOptions,
): raw is RawCachedOcrHints & { schemaVersion: number; hints: unknown[] } {
  const supportedSchema = [
    GROUPING_EVIDENCE_MIGRATION_SCHEMA_VERSION,
    OCR_HINT_CACHE_SCHEMA_VERSION,
  ].includes(Number(raw.schemaVersion));
  return (
    supportedSchema &&
    raw.imagePath === page.imagePath &&
    raw.width === page.width &&
    raw.height === page.height &&
    raw.sourceLanguage === normalizeOcrCacheLanguage(options.sourceLanguage) &&
    matchesOcrCacheConfiguration(raw.configuration, options) &&
    Array.isArray(raw.hints)
  );
}

function buildCachedOcrHints(
  raw: RawCachedOcrHints & { schemaVersion: number; hints: unknown[] },
): CachedOcrHints {
  const schemaVersion = Number(raw.schemaVersion);
  const groupingEvidence = normalizeGroupingEvidence(raw.groupingEvidence);
  return {
    schemaVersion,
    requiresGroupingEvidenceRefresh:
      schemaVersion === GROUPING_EVIDENCE_MIGRATION_SCHEMA_VERSION ||
      groupingEvidence?.status === "unavailable",
    result: {
      hints: raw.hints,
      diagnostics: Array.isArray(raw.diagnostics) ? raw.diagnostics : [],
      noTextDetected: Boolean(raw.noTextDetected),
      textEvidenceCount: Number.isFinite(raw.textEvidenceCount)
        ? Number(raw.textEvidenceCount)
        : undefined,
      groupingEvidence,
    },
  };
}

export function removeStaleAnimeTextEvidence(
  result: OcrBboxResult,
): OcrBboxResult {
  let changed = false;
  const hints = result.hints.map((hint) => {
    if (!hint || typeof hint !== "object" || Array.isArray(hint)) {
      return hint;
    }
    const record = hint as Record<string, unknown>;
    if (
      !ANIME_TEXT_EVIDENCE_KEYS.some((key) =>
        Object.prototype.hasOwnProperty.call(record, key),
      )
    ) {
      return hint;
    }
    changed = true;
    const cleaned = { ...record };
    for (const key of ANIME_TEXT_EVIDENCE_KEYS) {
      delete cleaned[key];
    }
    return cleaned;
  });
  return changed ? { ...result, hints } : result;
}

export async function writeCachedOcrHints(
  cachePath: string,
  page: MangaPage,
  result: OcrBboxResult,
  options: TranslationOptions,
): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(
    cachePath,
    `${JSON.stringify(
      {
        imagePath: page.imagePath,
        width: page.width,
        height: page.height,
        sourceLanguage: normalizeOcrCacheLanguage(options.sourceLanguage),
        configuration: buildOcrCacheConfiguration(options),
        schemaVersion: OCR_HINT_CACHE_SCHEMA_VERSION,
        hints: result.hints,
        diagnostics: result.diagnostics,
        noTextDetected: Boolean(result.noTextDetected),
        textEvidenceCount: Number.isFinite(result.textEvidenceCount)
          ? result.textEvidenceCount
          : undefined,
        groupingEvidence: result.groupingEvidence,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function getOcrHintsOutputDir(
  runPaths: ChapterRunPaths,
  page: MangaPage,
): string {
  return join(runPaths.chapterDir, "ocr-hints", page.id);
}

function normalizeOcrCacheLanguage(sourceLanguage?: string): string {
  return normalizeLanguageCode(sourceLanguage, DEFAULT_SOURCE_LANGUAGE);
}

function normalizeGroupingEvidence(
  value: unknown,
): OcrBboxResult["groupingEvidence"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.contractVersion !== 1 ||
    (record.status !== "completed" && record.status !== "unavailable")
  ) {
    return undefined;
  }
  return {
    contractVersion: 1,
    status: record.status,
  };
}
