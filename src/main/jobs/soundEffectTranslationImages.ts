import { nativeImage } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MangaPage } from "../../shared/libraryTypes";
import type { PixelRect } from "../../shared/region";
import { normalizedRegionToPixelRect } from "../../shared/region";
import type { SoundEffectReviewRegion } from "../../shared/soundEffectReview";
import {
  loadImageForRegionCrop,
  type ImageDecodeFallback,
} from "../regionCrop";
import { throwIfAborted } from "../pipeline/failure";

const CONTEXT_PIXEL_BUDGET = 1280 * 720;
const CONTEXT_MAX_LONG_SIDE = 1600;
const CROP_MIN_SHORT_SIDE = 384;
const CROP_MAX_LONG_SIDE = 1024;
const CROP_MAX_UPSCALE = 12;

export type SoundEffectTranslationImages = {
  context: { path: string; width: number; height: number };
  crop: { path: string; width: number; height: number };
};

/**
 * Builds exactly two visual inputs for one immutable SFX candidate: a cheap
 * marked whole-page context image and a high-detail enlarged target crop.
 */
export async function buildSoundEffectTranslationImages(
  page: MangaPage,
  region: SoundEffectReviewRegion,
  outputDir: string,
  decodeFallback: ImageDecodeFallback,
  signal?: AbortSignal,
): Promise<SoundEffectTranslationImages> {
  throwIfAborted(signal ?? new AbortController().signal);
  const source = await loadImageForRegionCrop(
    page.imagePath,
    decodeFallback,
    signal,
  );
  const sourceSize = source.getSize();
  if (sourceSize.width <= 0 || sourceSize.height <= 0) {
    throw new Error("효과음 번역 원본 이미지를 읽지 못했습니다.");
  }
  const artifactDir = join(outputDir, safeFileSegment(region.id));
  await mkdir(artifactDir, { recursive: true });
  const context = await writeMarkedContextImage(
    source,
    region,
    artifactDir,
    signal,
  );
  const crop = await writeTargetCropImage(source, region, artifactDir, signal);
  return { context, crop };
}

async function writeMarkedContextImage(
  source: Electron.NativeImage,
  region: SoundEffectReviewRegion,
  outputDir: string,
  signal?: AbortSignal,
): Promise<SoundEffectTranslationImages["context"]> {
  throwIfAborted(signal ?? new AbortController().signal);
  const sourceSize = source.getSize();
  const size = resolveSoundEffectContextSize(
    sourceSize.width,
    sourceSize.height,
  );
  const resized = source.resize({ ...size, quality: "best" });
  if (resized.isEmpty()) {
    throw new Error("효과음 페이지 문맥 이미지를 만들지 못했습니다.");
  }
  const bitmap = Buffer.from(resized.toBitmap());
  const target = normalizedRegionToPixelRect(region.bbox, size, 2);
  applySoundEffectTargetHighlight(bitmap, size.width, size.height, target);
  const marked = nativeImage.createFromBitmap(bitmap, size);
  if (marked.isEmpty()) {
    throw new Error("효과음 대상 표시 이미지를 만들지 못했습니다.");
  }
  const path = join(outputDir, "marked-page-context.png");
  await writeFile(path, marked.toPNG(), { signal });
  return { path, ...size };
}

async function writeTargetCropImage(
  source: Electron.NativeImage,
  region: SoundEffectReviewRegion,
  outputDir: string,
  signal?: AbortSignal,
): Promise<SoundEffectTranslationImages["crop"]> {
  throwIfAborted(signal ?? new AbortController().signal);
  const sourceSize = source.getSize();
  const rawRect = normalizedRegionToPixelRect(region.bbox, sourceSize, 2);
  const rect = expandTargetRect(rawRect, sourceSize.width, sourceSize.height);
  const rawCrop = source.crop({
    x: rect.x,
    y: rect.y,
    width: rect.w,
    height: rect.h,
  });
  if (rawCrop.isEmpty()) {
    throw new Error("효과음 대상 crop을 만들지 못했습니다.");
  }
  const size = resolveSoundEffectCropSize(rect.w, rect.h);
  const crop =
    size.width === rect.w && size.height === rect.h
      ? rawCrop
      : rawCrop.resize({ ...size, quality: "best" });
  if (crop.isEmpty()) {
    throw new Error("효과음 대상 crop을 확대하지 못했습니다.");
  }
  const path = join(outputDir, "target-crop.png");
  await writeFile(path, crop.toPNG(), { signal });
  return { path, ...size };
}

export function resolveSoundEffectContextSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const pixelScale = Math.sqrt(CONTEXT_PIXEL_BUDGET / (safeWidth * safeHeight));
  const longSideScale = CONTEXT_MAX_LONG_SIDE / Math.max(safeWidth, safeHeight);
  const scale = Math.min(1, pixelScale, longSideScale);
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

export function resolveSoundEffectCropSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const minSide = Math.min(safeWidth, safeHeight);
  const maxSide = Math.max(safeWidth, safeHeight);
  const scale = Math.max(
    1,
    Math.min(
      CROP_MAX_UPSCALE,
      CROP_MIN_SHORT_SIDE / minSide,
      CROP_MAX_LONG_SIDE / maxSide,
    ),
  );
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

/** Paint translucent cyan inside and a high-contrast magenta outline. */
export function applySoundEffectTargetHighlight(
  bitmap: Buffer,
  width: number,
  height: number,
  target: PixelRect,
): void {
  const left = clamp(target.x, 0, width - 1);
  const top = clamp(target.y, 0, height - 1);
  const right = clamp(target.x + target.w - 1, left, width - 1);
  const bottom = clamp(target.y + target.h - 1, top, height - 1);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      blendBgra(bitmap, width, x, y, { b: 255, g: 218, r: 0 }, 0.14);
    }
  }
  const thickness = Math.max(4, Math.round(Math.min(width, height) * 0.006));
  for (let inset = 0; inset < thickness; inset += 1) {
    paintBorder(bitmap, width, height, {
      x: left - inset,
      y: top - inset,
      w: right - left + 1 + inset * 2,
      h: bottom - top + 1 + inset * 2,
    });
  }
}

function expandTargetRect(
  rect: PixelRect,
  pageWidth: number,
  pageHeight: number,
): PixelRect {
  const margin = Math.max(12, Math.round(Math.min(rect.w, rect.h) * 0.12));
  const x = Math.max(0, rect.x - margin);
  const y = Math.max(0, rect.y - margin);
  const right = Math.min(pageWidth, rect.x + rect.w + margin);
  const bottom = Math.min(pageHeight, rect.y + rect.h + margin);
  return { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
}

function paintBorder(
  bitmap: Buffer,
  width: number,
  height: number,
  rect: PixelRect,
): void {
  const left = clamp(rect.x, 0, width - 1);
  const top = clamp(rect.y, 0, height - 1);
  const right = clamp(rect.x + rect.w - 1, left, width - 1);
  const bottom = clamp(rect.y + rect.h - 1, top, height - 1);
  for (let x = left; x <= right; x += 1) {
    setBgra(bitmap, width, x, top, 143, 45, 255);
    setBgra(bitmap, width, x, bottom, 143, 45, 255);
  }
  for (let y = top; y <= bottom; y += 1) {
    setBgra(bitmap, width, left, y, 143, 45, 255);
    setBgra(bitmap, width, right, y, 143, 45, 255);
  }
}

function blendBgra(
  bitmap: Buffer,
  width: number,
  x: number,
  y: number,
  color: { b: number; g: number; r: number },
  alpha: number,
): void {
  const offset = (y * width + x) * 4;
  bitmap[offset] = blend(bitmap[offset] ?? 0, color.b, alpha);
  bitmap[offset + 1] = blend(bitmap[offset + 1] ?? 0, color.g, alpha);
  bitmap[offset + 2] = blend(bitmap[offset + 2] ?? 0, color.r, alpha);
  bitmap[offset + 3] = 255;
}

function blend(base: number, overlay: number, alpha: number): number {
  return Math.round(base * (1 - alpha) + overlay * alpha);
}

function setBgra(
  bitmap: Buffer,
  width: number,
  x: number,
  y: number,
  b: number,
  g: number,
  r: number,
): void {
  const offset = (y * width + x) * 4;
  bitmap[offset] = b;
  bitmap[offset + 1] = g;
  bitmap[offset + 2] = r;
  bitmap[offset + 3] = 255;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/gu, "_").slice(0, 80) || "region";
}
