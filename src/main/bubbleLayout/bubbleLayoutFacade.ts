import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { isGeneratedBubbleLayout } from "../../shared/bubbleLayout";
import { logWarn } from "../logger";
import type {
  BubbleLayoutRunner,
  BubbleLayoutRunnerFactoryOptions,
  BubbleLayoutRunnerRequest,
  BubbleLayoutRunnerResult,
} from "../inpainting/bubbleLayoutRunner";
import { loadPageImage } from "../inpainting/imageIO";
import { ensureComicBubbleDetectorAssets } from "./assets";
import { detectComicPageLayout } from "./detector";
import type { ComicPageDetectionResult } from "./contracts";
import {
  processDetectedBubbleLayouts,
  resolveBubbleLayoutBlockRevision,
} from "./bubbleLayoutPageProcessor";

export function createProductionBubbleLayoutRunner(
  options: BubbleLayoutRunnerFactoryOptions,
): BubbleLayoutRunner {
  const detectionsByOriginalPath = new Map<
    string,
    Promise<ComicPageDetectionResult>
  >();
  return {
    runPage: (request) =>
      runProductionBubbleLayout(options, request, detectionsByOriginalPath),
  };
}

async function runProductionBubbleLayout(
  options: BubbleLayoutRunnerFactoryOptions,
  request: BubbleLayoutRunnerRequest,
  detectionsByOriginalPath: Map<string, Promise<ComicPageDetectionResult>>,
): Promise<BubbleLayoutRunnerResult> {
  let pageRevision: string | null = null;
  try {
    throwIfAborted(request.signal);
    pageRevision = await resolvePageRevision(
      request.page.imagePath,
      request.imagePath,
    );
    const detection = await detectOriginalPageLayout(
      options,
      request,
      detectionsByOriginalPath,
    );
    const image = await loadPageImage(
      request.imagePath,
      options.decodeFallback,
    );
    throwIfAborted(request.signal);
    const normalizedImage = normalizeImageSize(
      image,
      detection.imageWidth,
      detection.imageHeight,
    );
    return {
      patches: processDetectedBubbleLayouts({
        page: request.page,
        bitmap: normalizedImage.toBitmap(),
        imageWidth: detection.imageWidth,
        imageHeight: detection.imageHeight,
        detections: detection.detections,
        policy: request.policy,
        paddingRatio: request.paddingRatio,
        pageRevision,
        repairOriginalTextInk:
          !request.page.inpaintedImagePath &&
          request.imagePath === request.page.imagePath,
      }),
    };
  } catch (error) {
    if (request.signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    logWarn("Bubble-aware layout postprocess skipped", {
      pageId: request.page.id,
      error,
    });
    return {
      patches: clearStaleGeneratedLayouts(request, pageRevision),
    };
  }
}

function detectOriginalPageLayout(
  options: BubbleLayoutRunnerFactoryOptions,
  request: BubbleLayoutRunnerRequest,
  detectionsByOriginalPath: Map<string, Promise<ComicPageDetectionResult>>,
): Promise<ComicPageDetectionResult> {
  const originalPath = request.page.imagePath;
  const cached = detectionsByOriginalPath.get(originalPath);
  if (cached) {
    return cached;
  }
  const detection = detectOriginalPageLayoutUncached(options, request);
  // A runner belongs to one inpainting job. Successful raw detections are
  // shared by the mask pre-pass and final postprocess.
  detectionsByOriginalPath.set(originalPath, detection);
  void detection.catch(() => {
    // A failed pre-pass must not consume the final postprocess's retry.
    if (detectionsByOriginalPath.get(originalPath) === detection) {
      detectionsByOriginalPath.delete(originalPath);
    }
  });
  return detection;
}

async function detectOriginalPageLayoutUncached(
  options: BubbleLayoutRunnerFactoryOptions,
  request: BubbleLayoutRunnerRequest,
): Promise<ComicPageDetectionResult> {
  const detectorAssets = await ensureComicBubbleDetectorAssets({
    dataRoot: options.dataRoot,
    signal: request.signal,
  });
  return detectComicPageLayout({
    imagePath: request.page.imagePath,
    modelPath: detectorAssets.modelPath,
    wasmBinaryPath: detectorAssets.wasmBinaryPath,
    wasmModulePath: detectorAssets.wasmModulePath,
    scoreThreshold: 0.35,
    signal: request.signal,
    decodeFallback: options.decodeFallback,
  });
}

function normalizeImageSize(
  image: Electron.NativeImage,
  width: number,
  height: number,
): Electron.NativeImage {
  const size = image.getSize();
  return size.width === width && size.height === height
    ? image
    : image.resize({ width, height, quality: "best" });
}

async function resolvePageRevision(
  originalPath: string,
  inpaintedPath: string,
): Promise<string> {
  const [original, inpainted] = await Promise.all([
    stat(originalPath),
    stat(inpaintedPath),
  ]);
  return createHash("sha256")
    .update(
      `${originalPath}:${original.size}:${original.mtimeMs}:${inpaintedPath}:${inpainted.size}:${inpainted.mtimeMs}`,
    )
    .digest("hex");
}

function clearStaleGeneratedLayouts(
  request: BubbleLayoutRunnerRequest,
  pageRevision: string | null,
): BubbleLayoutRunnerResult["patches"] {
  if (!pageRevision) return [];
  return request.page.blocks
    .filter(
      (block) =>
        isGeneratedBubbleLayout(block.bubbleLayout) &&
        block.bubbleLayout?.sourceImageRevision !==
          resolveBubbleLayoutBlockRevision(pageRevision, block),
    )
    .map((block) => ({
      blockId: block.id,
      renderBbox: null,
      renderBboxSpace: null,
      bubbleLayout: null,
    }));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
