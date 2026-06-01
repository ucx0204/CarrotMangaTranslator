import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TranslationOptions } from "../appSettings";
import { logWarn } from "../logger";
import { clamp, pixelsToBbox } from "../../shared/geometry";
import type { BBox, MangaPage } from "../../shared/types";
import { containsJapaneseKana, hasUncertaintyMarker, normalizeConfidence } from "./overlayItems";
import type { TranslationRuntimePort } from "./translationRuntimePort";
import type { CropRetryItem, CropRetryTarget, ModelEndpointHandle, OverlayItem, PipelineOptions } from "./types";

const CROP_RETRY_CONFIDENCE_THRESHOLD = 0.72;
const CROP_RETRY_MAX_ITEMS_PER_PAGE = readPositiveInteger(process.env.MANGA_TRANSLATOR_CROP_RETRY_MAX_ITEMS_PER_PAGE) ?? 8;
const CROP_RETRY_MIN_SIDE_PX = 192;
const CROP_RETRY_MIN_MARGIN_PX = 64;
const CROP_RETRY_MARGIN_RATIO = 0.5;

type CropRetryContext = {
  runtime: TranslationRuntimePort;
  server: ModelEndpointHandle;
  pageOptions: TranslationOptions;
  page: MangaPage;
  items: OverlayItem[];
  emit: PipelineOptions["emit"];
  jobId: string;
  pageIndex: number;
  pageTotal: number;
  progressTotal: number;
};

export async function maybeRetryLowConfidenceItems({
  runtime,
  server,
  pageOptions,
  page,
  items,
  emit,
  jobId,
  pageIndex,
  pageTotal,
  progressTotal
}: CropRetryContext): Promise<OverlayItem[]> {
  if (!runtime.requestCropRetryTranslation || !runtime.parseRetryItems) {
    return items;
  }

  const targets = selectCropRetryTargets(items, page);
  if (targets.length === 0) {
    return items;
  }

  const retryOptions = {
    ...pageOptions,
    label: `${pageOptions.label}-crop-retry`,
    outputDir: join(pageOptions.outputDir, "crop-retry")
  };

  emit({
    id: jobId,
    kind: "gemma-analysis",
    status: "running",
    progressText: `${page.name} 낮은 신뢰도 crop 재확인 중`,
    phase: "model_requesting",
    progressCurrent: pageIndex,
    progressTotal,
    pageIndex,
    pageTotal,
    detail: `${targets.length}개 항목`
  });

  try {
    const result = await runtime.requestCropRetryTranslation(server, retryOptions, targets);
    if (!result.outputText.trim()) {
      return items;
    }

    await runtime.saveArtifacts(retryOptions, result);
    const retryItems = runtime.parseRetryItems(result.outputText);
    await mkdir(retryOptions.outputDir, { recursive: true });
    await writeFile(join(retryOptions.outputDir, "crop-retry-items.json"), `${JSON.stringify({ items: retryItems }, null, 2)}\n`, "utf8");
    return mergeCropRetryItems(items, retryItems, targets, page);
  } catch (error) {
    logWarn("Crop retry failed; keeping first-pass overlay items", {
      pageId: page.id,
      pageName: page.name,
      targetCount: targets.length,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    return items;
  }
}

export function selectCropRetryTargets(
  items: OverlayItem[],
  page: MangaPage
): CropRetryTarget[] {
  const candidates = new Map<number, { item: OverlayItem; reason: CropRetryTarget["reason"]; priority: number }>();

  function addCandidate(item: OverlayItem, reason: CropRetryTarget["reason"], priority: number): void {
    const previous = candidates.get(item.id);
    if (previous && previous.priority >= priority) {
      return;
    }
    candidates.set(item.id, { item, reason, priority });
  }

  for (const item of items) {
    if (shouldRetryCropItem(item)) {
      addCandidate(item, "low-confidence", 40);
    }
  }

  return [...candidates.values()]
    .sort((a, b) => b.priority - a.priority || a.item.id - b.item.id)
    .slice(0, CROP_RETRY_MAX_ITEMS_PER_PAGE)
    .map(({ item, reason }) => ({
      id: item.id,
      type: item.type,
      textRole: item.textRole,
      bbox: item.bbox,
      cropBox: buildExpandedCropBox(item.bbox, page),
      reason,
      jp: item.jp,
      ko: item.ko,
      direction: item.direction,
      angle: item.angle,
      fontSize: item.fontSize,
      confidence: item.confidence
    }));
}

export function mergeCropRetryItems(
  items: OverlayItem[],
  retryItems: CropRetryItem[],
  targets: CropRetryTarget[],
  page: MangaPage
): OverlayItem[] {
  const retryById = new Map(retryItems.map((item) => [item.id, item]));
  const targetById = new Map(targets.map((target) => [target.id, target]));

  const merged: OverlayItem[] = [];
  for (const item of items) {
    const retry = retryById.get(item.id);
    const target = targetById.get(item.id);
    if (!retry) {
      merged.push(item);
      continue;
    }

    if (isRejectRetryItem(retry)) {
      continue;
    }

    if (!isUsableRetryItem(retry)) {
      merged.push(item);
      continue;
    }

    const baseHadProblem = shouldRetryCropItem(item);
    const retryConfidence = normalizeConfidence(retry.confidence, Number.NaN);
    const baseConfidence = normalizeConfidence(item.confidence, Number.NaN);
    if (!baseHadProblem && Number.isFinite(retryConfidence) && Number.isFinite(baseConfidence) && retryConfidence + 0.02 < baseConfidence) {
      merged.push(item);
      continue;
    }

    const retryBbox = retry.bbox && target ? cropRetryBboxToPageBbox(retry.bbox, target, page) : null;
    merged.push({
      ...item,
      type: retry.type || item.type,
      textRole: retry.textRole || item.textRole,
      bbox: retryBbox ?? item.bbox,
      jp: retry.jp || item.jp,
      ko: retry.ko || item.ko,
      direction: retry.direction ?? item.direction,
      angle: retry.angle ?? item.angle,
      fontSize: retry.fontSize ?? item.fontSize,
      confidence: Number.isFinite(retryConfidence) ? retryConfidence : item.confidence
    });
  }
  return merged;
}

function shouldRetryCropItem(item: OverlayItem): boolean {
  const confidence = normalizeConfidence(item.confidence, Number.NaN);
  if (Number.isFinite(confidence) && confidence < CROP_RETRY_CONFIDENCE_THRESHOLD) {
    return true;
  }

  if (hasUncertaintyMarker(item.jp) || hasUncertaintyMarker(item.ko) || containsJapaneseKana(item.ko)) {
    return true;
  }

  return false;
}

function buildExpandedCropBox(bbox: BBox, page: MangaPage): BBox {
  const pageWidth = Math.max(1, page.width);
  const pageHeight = Math.max(1, page.height);
  const left = (bbox.x / 1000) * pageWidth;
  const top = (bbox.y / 1000) * pageHeight;
  const width = Math.max(1, (bbox.w / 1000) * pageWidth);
  const height = Math.max(1, (bbox.h / 1000) * pageHeight);
  const marginX = Math.max(CROP_RETRY_MIN_MARGIN_PX, width * CROP_RETRY_MARGIN_RATIO);
  const marginY = Math.max(CROP_RETRY_MIN_MARGIN_PX, height * CROP_RETRY_MARGIN_RATIO);
  const centerX = left + width / 2;
  const centerY = top + height / 2;
  const expandedWidth = Math.max(CROP_RETRY_MIN_SIDE_PX, width + marginX * 2);
  const expandedHeight = Math.max(CROP_RETRY_MIN_SIDE_PX, height + marginY * 2);
  const cropLeft = clamp(centerX - expandedWidth / 2, 0, Math.max(0, pageWidth - 1));
  const cropTop = clamp(centerY - expandedHeight / 2, 0, Math.max(0, pageHeight - 1));
  const cropRight = clamp(centerX + expandedWidth / 2, cropLeft + 1, pageWidth);
  const cropBottom = clamp(centerY + expandedHeight / 2, cropTop + 1, pageHeight);
  return {
    x: Math.round(cropLeft),
    y: Math.round(cropTop),
    w: Math.round(cropRight - cropLeft),
    h: Math.round(cropBottom - cropTop)
  };
}

function normalizeRetryTextRole(value: unknown): string {
  const role = String(value ?? "").trim().toLowerCase();
  if (role === "sound" || role === "ordinary" || role === "nontext") {
    return role;
  }
  return "";
}

function cropRetryBboxToPageBbox(retryBbox: BBox, target: CropRetryTarget, page: MangaPage): BBox | null {
  const crop = target.cropBox;
  if (!crop || crop.w <= 0 || crop.h <= 0) {
    return null;
  }

  if (
    retryBbox.x < 0 ||
    retryBbox.y < 0 ||
    retryBbox.w <= 0 ||
    retryBbox.h <= 0 ||
    retryBbox.x + retryBbox.w > crop.w ||
    retryBbox.y + retryBbox.h > crop.h
  ) {
    return null;
  }

  const left = clamp(retryBbox.x, 0, crop.w);
  const top = clamp(retryBbox.y, 0, crop.h);
  const right = clamp(retryBbox.x + retryBbox.w, left + 1, crop.w);
  const bottom = clamp(retryBbox.y + retryBbox.h, top + 1, crop.h);
  return pixelsToBbox(
    {
      x: crop.x + left,
      y: crop.y + top,
      w: right - left,
      h: bottom - top
    },
    page.width,
    page.height
  );
}

function isRejectRetryItem(item: CropRetryItem): boolean {
  const type = String(item.type ?? "").trim().toLowerCase();
  return type === "reject" || normalizeRetryTextRole(item.textRole) === "nontext" || isNonTextMarker(item.jp) || isNonTextMarker(item.ko);
}

function isUsableRetryItem(item: CropRetryItem): boolean {
  return Boolean(String(item.ko ?? "").trim()) && !hasUncertaintyMarker(item.ko);
}

function isNonTextMarker(value: string | undefined): boolean {
  return /^\s*\[(?:non-?text|not text|reject)\]\s*$/i.test(String(value ?? ""));
}

function readPositiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}
