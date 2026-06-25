import type { PixelRect } from "../../shared/region";
import type { MangaPage } from "../../shared/types";
import type { OcrBboxResult } from "./types";

type OcrHintRecord = Record<string, unknown> & {
  x1?: unknown;
  y1?: unknown;
  x2?: unknown;
  y2?: unknown;
};

type OcrBox = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

const MIN_INTERSECTION_RATIO = 0.25;

export function mapPageOcrResultToRegionCrop({
  cropPage,
  cropRect,
  sourceResult,
}: {
  cropPage: MangaPage;
  cropRect: PixelRect;
  sourceResult?: OcrBboxResult | null;
}): OcrBboxResult {
  if (!sourceResult) {
    return {
      hints: [],
      diagnostics: [{ provider: "region-context", reason: "missing-source" }],
      noTextDetected: false,
      textEvidenceCount: 0,
    };
  }

  const hints = (Array.isArray(sourceResult.hints) ? sourceResult.hints : [])
    .map((hint) => readHintRecord(hint))
    .filter((hint): hint is OcrHintRecord => Boolean(hint))
    .map((hint) => mapHintToCrop(hint, cropRect))
    .filter((hint): hint is OcrHintRecord => Boolean(hint))
    .map((hint, index) => ({ ...hint, id: index + 1 }));

  return {
    hints,
    diagnostics: [
      ...(Array.isArray(sourceResult.diagnostics)
        ? sourceResult.diagnostics
        : []),
      {
        provider: "region-context",
        sourceHintCount: Array.isArray(sourceResult.hints)
          ? sourceResult.hints.length
          : 0,
        cropHintCount: hints.length,
        cropWidth: cropPage.width,
        cropHeight: cropPage.height,
      },
    ],
    noTextDetected: false,
    textEvidenceCount: countTextEvidence(hints),
  };
}

function mapHintToCrop(
  hint: OcrHintRecord,
  cropRect: PixelRect,
): OcrHintRecord | null {
  const box = readOcrBox(hint);
  if (!box || !shouldIncludeBox(box, cropRect)) {
    return null;
  }

  const x1 = clamp(Math.round(box.x1 - cropRect.x), 0, cropRect.w);
  const y1 = clamp(Math.round(box.y1 - cropRect.y), 0, cropRect.h);
  const x2 = clamp(Math.round(box.x2 - cropRect.x), 0, cropRect.w);
  const y2 = clamp(Math.round(box.y2 - cropRect.y), 0, cropRect.h);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const right = Math.max(x1, x2);
  const bottom = Math.max(y1, y2);
  if (right - left < 2 || bottom - top < 2) {
    return null;
  }

  return {
    ...hint,
    x1: left,
    y1: top,
    x2: right,
    y2: bottom,
  };
}

function shouldIncludeBox(box: OcrBox, cropRect: PixelRect): boolean {
  const centerX = (box.x1 + box.x2) / 2;
  const centerY = (box.y1 + box.y2) / 2;
  if (
    centerX >= cropRect.x &&
    centerX <= cropRect.x + cropRect.w &&
    centerY >= cropRect.y &&
    centerY <= cropRect.y + cropRect.h
  ) {
    return true;
  }

  const intersection = intersectionArea(box, cropRect);
  const area = Math.max(1, (box.x2 - box.x1) * (box.y2 - box.y1));
  return intersection / area >= MIN_INTERSECTION_RATIO;
}

function intersectionArea(box: OcrBox, cropRect: PixelRect): number {
  const left = Math.max(box.x1, cropRect.x);
  const top = Math.max(box.y1, cropRect.y);
  const right = Math.min(box.x2, cropRect.x + cropRect.w);
  const bottom = Math.min(box.y2, cropRect.y + cropRect.h);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function readHintRecord(value: unknown): OcrHintRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as OcrHintRecord)
    : null;
}

function readOcrBox(hint: OcrHintRecord): OcrBox | null {
  const x1 = Number(hint.x1);
  const y1 = Number(hint.y1);
  const x2 = Number(hint.x2);
  const y2 = Number(hint.y2);
  if (![x1, y1, x2, y2].every(Number.isFinite)) {
    return null;
  }
  return {
    x1: Math.min(x1, x2),
    y1: Math.min(y1, y2),
    x2: Math.max(x1, x2),
    y2: Math.max(y1, y2),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function countTextEvidence(hints: OcrHintRecord[]): number {
  return hints.filter((hint) => String(hint.ocrText ?? "").trim()).length;
}
