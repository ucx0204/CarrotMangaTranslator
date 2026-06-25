import type { PreviousOverlayBlockForPrompt } from "../appSettings";
import type { BBox, MangaPage } from "../../shared/types";

export function buildPreviousBlocksForPrompt(
  page: MangaPage,
  ocrHints: unknown[],
): PreviousOverlayBlockForPrompt[] {
  return page.blocks.slice(0, 80).map((block, index) => {
    const bbox = normalizeBlockBboxForPrompt(block.bbox, block.bboxSpace, page);
    return {
      previousId: block.id,
      index: index + 1,
      candidateId: findMatchingOcrCandidateId(bbox, ocrHints, page),
      bbox,
      textRole: inferPreviousBlockTextRole(block.translatedText),
      sourceText: block.sourceText,
      translatedText: block.translatedText,
      confidence: block.confidence,
    };
  });
}

function normalizeBlockBboxForPrompt(
  bbox: BBox,
  bboxSpace: "normalized_1000" | "pixels" | undefined,
  page: MangaPage,
): BBox {
  if (bboxSpace === "pixels") {
    return {
      x: Math.round((bbox.x / page.width) * 1000),
      y: Math.round((bbox.y / page.height) * 1000),
      w: Math.round((bbox.w / page.width) * 1000),
      h: Math.round((bbox.h / page.height) * 1000),
    };
  }
  return {
    x: Math.round(bbox.x),
    y: Math.round(bbox.y),
    w: Math.round(bbox.w),
    h: Math.round(bbox.h),
  };
}

function findMatchingOcrCandidateId(
  previousBbox: BBox,
  ocrHints: unknown[],
  page: MangaPage,
): number | undefined {
  let bestId: number | undefined;
  let bestScore = 0;
  for (const hint of ocrHints) {
    if (!hint || typeof hint !== "object") {
      continue;
    }
    const record = hint as Record<string, unknown>;
    const id = Number(record.id);
    const x1 = Number(record.x1);
    const y1 = Number(record.y1);
    const x2 = Number(record.x2);
    const y2 = Number(record.y2);
    if (
      !Number.isInteger(id) ||
      id <= 0 ||
      ![x1, y1, x2, y2].every(Number.isFinite)
    ) {
      continue;
    }
    const hintBbox = {
      x: (Math.min(x1, x2) / page.width) * 1000,
      y: (Math.min(y1, y2) / page.height) * 1000,
      w: (Math.abs(x2 - x1) / page.width) * 1000,
      h: (Math.abs(y2 - y1) / page.height) * 1000,
    };
    const score = bboxOverlapRatio(previousBbox, hintBbox);
    if (score > bestScore) {
      bestScore = score;
      bestId = id;
    }
  }
  return bestScore > 0.12 ||
    (bestId && centerInside(previousBbox, bestId, ocrHints, page))
    ? bestId
    : undefined;
}

function centerInside(
  bbox: BBox,
  id: number,
  ocrHints: unknown[],
  page: MangaPage,
): boolean {
  const hint = ocrHints.find(
    (candidate) =>
      candidate &&
      typeof candidate === "object" &&
      Number((candidate as Record<string, unknown>).id) === id,
  );
  if (!hint || typeof hint !== "object") {
    return false;
  }
  const record = hint as Record<string, unknown>;
  const x1 = Number(record.x1);
  const y1 = Number(record.y1);
  const x2 = Number(record.x2);
  const y2 = Number(record.y2);
  if (![x1, y1, x2, y2].every(Number.isFinite)) {
    return false;
  }
  const centerX = bbox.x + bbox.w / 2;
  const centerY = bbox.y + bbox.h / 2;
  const left = (Math.min(x1, x2) / page.width) * 1000;
  const top = (Math.min(y1, y2) / page.height) * 1000;
  const right = (Math.max(x1, x2) / page.width) * 1000;
  const bottom = (Math.max(y1, y2) / page.height) * 1000;
  return (
    centerX >= left && centerX <= right && centerY >= top && centerY <= bottom
  );
}

function bboxOverlapRatio(a: BBox, b: BBox): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
  const minArea = Math.max(1, Math.min(a.w * a.h, b.w * b.h));
  return overlap / minArea;
}

function inferPreviousBlockTextRole(text: string): "ordinary" | "sound" {
  const compact = text.replace(/\s+/g, "");
  return compact.length <= 6 && !/[.!?。！？]/.test(compact)
    ? "sound"
    : "ordinary";
}
