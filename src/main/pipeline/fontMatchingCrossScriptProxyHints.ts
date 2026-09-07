import type { MangaPage } from "../../shared/libraryTypes";
import type {
  FontMatchingSourceGlyphInputV1,
  FontMatchingSourceGlyphLineV1,
} from "./fontMatchingPagePixelInferenceTypes";
import type { FontMatchingOcrGeometryDirectionV2 } from "./fontMatchingOcrGeometryDirection";
import type { OverlayItem } from "./types";
import { buildRecognitionSourceLines } from "./overlayOcrSourceLineGeometry";

const CONTRACT_VERSION = "font-matching-source-glyph-input-v1" as const;

/**
 * Project semantic-OCR output to geometry plus glyph counts. Character
 * identities are deliberately discarded before the worker/model boundary.
 */
export function buildFontMatchingSourceGlyphInput({
  item,
  page,
  rawHints,
  sourceGeometryDirection,
}: Readonly<{
  item: OverlayItem;
  page: MangaPage;
  rawHints: unknown;
  sourceGeometryDirection?: FontMatchingOcrGeometryDirectionV2;
}>): FontMatchingSourceGlyphInputV1 | undefined {
  const direction = sourceGeometryDirection?.direction ?? item.direction;
  if (direction !== "horizontal" && direction !== "vertical") return undefined;
  const candidateIds =
    sourceGeometryDirection?.candidateMembership.originalCandidateIds ??
    item.candidateIds;
  const lines = readSourceGlyphLines(rawHints, candidateIds, page);
  const fallbackGlyphCount = countVisibleGlyphs(item.sourceText ?? item.jp);
  if (lines.length === 0 && fallbackGlyphCount === 0) return undefined;
  return {
    contractVersion: CONTRACT_VERSION,
    source: "semantic_ocr_geometry_and_count_only",
    direction,
    lines,
    fallbackGlyphCount: Math.max(1, fallbackGlyphCount),
  };
}

// OCR hint validation intentionally checks every untrusted field independently.
// eslint-disable-next-line complexity
function readSourceGlyphLines(
  rawHints: unknown,
  candidateIds: readonly number[] | undefined,
  page: MangaPage,
): FontMatchingSourceGlyphLineV1[] {
  if (!Array.isArray(rawHints) || !candidateIds?.length) return [];
  const allowedIds = new Set(candidateIds);
  const lines: FontMatchingSourceGlyphLineV1[] = [];
  const seenIds = new Set<number>();
  for (const value of rawHints) {
    if (!isRecord(value)) continue;
    const id = readPositiveInteger(value.id);
    if (id === null || !allowedIds.has(id) || seenIds.has(id)) continue;
    const x1 = readCoordinate(value.x1, 0, page.width);
    const y1 = readCoordinate(value.y1, 0, page.height);
    const x2 = readCoordinate(value.x2, 0, page.width);
    const y2 = readCoordinate(value.y2, 0, page.height);
    const glyphCount = countVisibleGlyphs(value.ocrText);
    if (
      x1 === null ||
      y1 === null ||
      x2 === null ||
      y2 === null ||
      x2 <= x1 ||
      y2 <= y1 ||
      glyphCount === 0
    ) {
      continue;
    }
    seenIds.add(id);
    const region = { x1, y1, x2, y2, glyphCount };
    lines.push(...(readRecognitionLines(value, region, page) ?? [region]));
  }
  return lines;
}

function readRecognitionLines(
  hint: Readonly<Record<string, unknown>>,
  parent: FontMatchingSourceGlyphLineV1,
  page: MangaPage,
): FontMatchingSourceGlyphLineV1[] | undefined {
  // Recognition subregions can still span multiple physical lines. Preserve
  // their supplied geometry; do not claim that this validates glyph boundaries.
  if (!Array.isArray(hint.recognitionSegments)) return undefined;
  const segments = hint.recognitionSegments.map((segment: unknown) => {
    if (!isRecord(segment)) return {};
    return {
      x1: readCoordinate(segment.x1, 0, page.width) ?? undefined,
      y1: readCoordinate(segment.y1, 0, page.height) ?? undefined,
      x2: readCoordinate(segment.x2, 0, page.width) ?? undefined,
      y2: readCoordinate(segment.y2, 0, page.height) ?? undefined,
      ocrText: typeof segment.ocrText === "string" ? segment.ocrText : "",
    };
  });
  const recognized = buildRecognitionSourceLines(
    { recognitionSegments: segments },
    parent,
    page,
  );
  if (!recognized) return undefined;
  const lines = recognized.map(({ bbox, sourceText }) => ({
    x1: (bbox.x * page.width) / 1000,
    y1: (bbox.y * page.height) / 1000,
    x2: ((bbox.x + bbox.w) * page.width) / 1000,
    y2: ((bbox.y + bbox.h) * page.height) / 1000,
    glyphCount: countVisibleGlyphs(sourceText),
  }));
  const keys = new Set(
    lines.map(({ x1, y1, x2, y2 }) => `${x1}:${y1}:${x2}:${y2}`),
  );
  return keys.size === lines.length &&
    lines.every((line) => line.glyphCount > 0)
    ? lines
    : undefined;
}

function countVisibleGlyphs(value: unknown): number {
  if (typeof value !== "string") return 0;
  return [...value].filter((character) => !/\s/u.test(character)).length;
}

function readCoordinate(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
