import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TranslationOptions } from "../appSettings";
import type { ChapterRunPaths } from "../library";
import type { JobEvent } from "../../shared/jobTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import { bboxToPixels } from "../../shared/geometry";
import {
  isJapaneseLanguageCode,
  isRtlLanguageCode,
} from "../../shared/translationLanguages";
import type { PixelRect } from "../../shared/region";
import { tMain } from "./localization";
import { loadImageForRegionCrop } from "../regionCrop";
import { throwIfAborted } from "./failure";
import { buildKeepBlocksOcrResult } from "./keepBlocksResult";
import type { PipelineDiagnostics } from "./translationAttemptLogging";
import type { OcrBboxResult, PipelineOptions } from "./types";
import type { TranslationRuntimePort } from "./translationRuntimePort";

const CROP_PADDING_PX = 8;
const MIN_CROP_SIZE_PX = 4;

/** pageId → (블록 인덱스 → 크롭 OCR 텍스트). 텍스트가 없으면 undefined. */
type KeepBlocksOcrTexts = Map<string, (string | undefined)[]>;

type KeepBlockCrop = {
  pageId: string;
  blockIndex: number;
  options: TranslationOptions;
};

/**
 * keep 페이지들의 OCR 힌트 맵을 만든다: 블록별 크롭 OCR 텍스트를 수집해
 * 블록 지오메트리 기반 합성 힌트에 부착한다.
 */
export async function prepareKeepBlockHints({
  runtime,
  baseOptions,
  keepPages,
  pageCount,
  runPaths,
  emit,
  jobId,
  signal,
  decodeImage,
  diagnostics,
}: {
  runtime: TranslationRuntimePort;
  baseOptions: TranslationOptions;
  keepPages: MangaPage[];
  pageCount: number;
  runPaths: ChapterRunPaths;
  emit: (event: JobEvent) => void;
  jobId: string;
  signal: AbortSignal;
  decodeImage?: PipelineOptions["decodeImage"];
  diagnostics: PipelineDiagnostics;
}): Promise<Map<string, OcrBboxResult>> {
  if (keepPages.length === 0) {
    return new Map<string, OcrBboxResult>();
  }
  diagnostics.info("Keep-blocks mode: using existing blocks as OCR hints", {
    jobId,
    keepPageCount: keepPages.length,
    pageCount,
  });
  const ocrTexts = await collectKeepBlocksOcrTexts({
    runtime,
    baseOptions,
    pages: keepPages,
    runPaths,
    emit,
    jobId,
    signal,
    decodeImage,
  });
  return new Map(
    keepPages.map((page) => [
      page.id,
      buildKeepBlocksOcrResult(page, ocrTexts.get(page.id)),
    ]),
  );
}

/**
 * keep 모드 페이지들의 각 블록 영역을 패딩 포함해 크롭한 뒤 선택된 OCR 배치로
 * 읽어, 블록별 텍스트 증거를 만든다. OCR 실패는 작업을 중지한다.
 */
async function collectKeepBlocksOcrTexts({
  runtime,
  baseOptions,
  pages,
  runPaths,
  emit,
  jobId,
  signal,
  decodeImage,
}: {
  runtime: TranslationRuntimePort;
  baseOptions: TranslationOptions;
  pages: MangaPage[];
  runPaths: ChapterRunPaths;
  emit: (event: JobEvent) => void;
  jobId: string;
  signal: AbortSignal;
  decodeImage?: PipelineOptions["decodeImage"];
}): Promise<KeepBlocksOcrTexts> {
  const texts: KeepBlocksOcrTexts = new Map(
    pages.map((page) => [page.id, page.blocks.map(() => undefined)]),
  );
  if (pages.length === 0) {
    return texts;
  }
  const crops = await writeKeepBlockCrops({
    baseOptions,
    pages,
    runPaths,
    signal,
    decodeImage,
  });
  if (crops.length === 0) {
    return texts;
  }
  emitKeepBlockOcrProgress(emit, jobId, 0, crops.length);
  const results = await runtime.collectOcrHintsBatch(
    crops.map((crop) => crop.options),
  );
  throwIfAborted(signal);
  for (const [index, crop] of crops.entries()) {
    const hints = results[index]?.hints;
    const text = joinCropOcrTexts(
      Array.isArray(hints) ? hints : [],
      baseOptions.sourceLanguage,
    );
    if (text) {
      texts.get(crop.pageId)?.splice(crop.blockIndex, 1, text);
    }
  }
  emitKeepBlockOcrProgress(emit, jobId, crops.length, crops.length);
  return texts;
}

/** 크롭 내 OCR 텍스트를 원문 언어에 맞는 기본 읽기 순서로 join. */
export function joinCropOcrTexts(
  hints: unknown[],
  sourceLanguage?: string,
): string {
  const entries: {
    text: string;
    cx: number;
    cy: number;
    w: number;
    h: number;
  }[] = [];
  for (const hint of hints) {
    if (!hint || typeof hint !== "object") {
      continue;
    }
    const record = hint as Record<string, unknown>;
    const text = String(record.ocrText ?? record.text ?? "").trim();
    const x1 = Number(record.x1);
    const y1 = Number(record.y1);
    const x2 = Number(record.x2);
    const y2 = Number(record.y2);
    if (!text || ![x1, y1, x2, y2].every(Number.isFinite)) {
      continue;
    }
    entries.push({
      text,
      cx: (x1 + x2) / 2,
      cy: (y1 + y2) / 2,
      w: Math.abs(x2 - x1),
      h: Math.abs(y2 - y1),
    });
  }
  const japaneseReadingOrder = isJapaneseLanguageCode(sourceLanguage);
  const rtlReadingOrder = isRtlLanguageCode(sourceLanguage);
  entries.sort((a, b) => {
    if (japaneseReadingOrder) {
      const columnTolerance = Math.max(4, Math.min(a.w, b.w) * 0.5);
      if (Math.abs(a.cx - b.cx) > columnTolerance) {
        return b.cx - a.cx;
      }
      return a.cy - b.cy;
    }
    const lineTolerance = Math.max(4, Math.min(a.h, b.h) * 0.5);
    if (Math.abs(a.cy - b.cy) > lineTolerance) {
      return a.cy - b.cy;
    }
    return rtlReadingOrder ? b.cx - a.cx : a.cx - b.cx;
  });
  return entries.map((entry) => entry.text).join(" ");
}

async function writeKeepBlockCrops({
  baseOptions,
  pages,
  runPaths,
  signal,
  decodeImage,
}: {
  baseOptions: TranslationOptions;
  pages: MangaPage[];
  runPaths: ChapterRunPaths;
  signal: AbortSignal;
  decodeImage?: PipelineOptions["decodeImage"];
}): Promise<KeepBlockCrop[]> {
  const decodeFallback: NonNullable<PipelineOptions["decodeImage"]> =
    decodeImage ?? (() => Promise.resolve(null));
  const totalBlockCount = pages.reduce(
    (sum, page) => sum + page.blocks.length,
    0,
  );
  const crops: KeepBlockCrop[] = [];
  for (const page of pages) {
    throwIfAborted(signal);
    const source = await loadImageForRegionCrop(page.imagePath, decodeFallback);
    const cropDir = join(runPaths.chapterDir, "keep-block-crops", page.id);
    await mkdir(cropDir, { recursive: true });
    for (const [blockIndex, block] of page.blocks.entries()) {
      const rect = blockCropRect(block, page, CROP_PADDING_PX);
      if (!rect) {
        continue;
      }
      const crop = source.crop({
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
      });
      if (crop.isEmpty()) {
        continue;
      }
      const cropPath = join(cropDir, `block-${blockIndex + 1}.png`);
      await writeFile(cropPath, crop.toPNG());
      const options: TranslationOptions = {
        ...baseOptions,
        imagePath: cropPath,
        imageWidth: rect.w,
        imageHeight: rect.h,
        outputDir: join(cropDir, `block-${blockIndex + 1}-ocr`),
        label: `keep-block-${crops.length + 1}`,
        ocrPageIndex: crops.length + 1,
        ocrPageTotal: totalBlockCount,
        ocrBatchTotal: totalBlockCount,
      };
      options.abortSignal = signal;
      crops.push({ pageId: page.id, blockIndex, options });
    }
  }
  return crops;
}

function blockCropRect(
  block: TranslationBlock,
  page: MangaPage,
  padPx: number,
): PixelRect | null {
  const rect =
    block.bboxSpace === "pixels"
      ? block.bbox
      : bboxToPixels(block.bbox, page.width, page.height);
  const x = Math.max(0, Math.floor(rect.x - padPx));
  const y = Math.max(0, Math.floor(rect.y - padPx));
  const right = Math.min(page.width, Math.ceil(rect.x + rect.w + padPx));
  const bottom = Math.min(page.height, Math.ceil(rect.y + rect.h + padPx));
  const w = right - x;
  const h = bottom - y;
  if (w < MIN_CROP_SIZE_PX || h < MIN_CROP_SIZE_PX) {
    return null;
  }
  return { x, y, w, h };
}

function emitKeepBlockOcrProgress(
  emit: (event: JobEvent) => void,
  jobId: string,
  current: number,
  total: number,
): void {
  emit({
    id: jobId,
    kind: "gemma-analysis",
    status: "running",
    progressText:
      current >= total ? tMain("ocr.blocksDone") : tMain("ocr.blocksRunning"),
    phase: "ocr_running",
    progressCurrent: current,
    progressTotal: total,
    detail: tMain("ocr.blocksDetail", { count: total }),
  });
}
