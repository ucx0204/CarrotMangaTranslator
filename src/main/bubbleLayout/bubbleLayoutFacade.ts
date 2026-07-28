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
import { ensureComicBubbleDetectorModel } from "./assets";
import { detectComicPageLayout } from "./detector";
import {
  processDetectedBubbleLayouts,
  resolveBubbleLayoutBlockRevision,
} from "./bubbleLayoutPageProcessor";

export function createProductionBubbleLayoutRunner(
  options: BubbleLayoutRunnerFactoryOptions,
): BubbleLayoutRunner {
  return {
    runPage: (request) => runProductionBubbleLayout(options, request),
  };
}

async function runProductionBubbleLayout(
  options: BubbleLayoutRunnerFactoryOptions,
  request: BubbleLayoutRunnerRequest,
): Promise<BubbleLayoutRunnerResult> {
  let pageRevision: string | null = null;
  try {
    throwIfAborted(request.signal);
    pageRevision = await resolvePageRevision(
      request.page.imagePath,
      request.imagePath,
    );
    const modelPath = await ensureComicBubbleDetectorModel({
      dataRoot: options.dataRoot,
      signal: request.signal,
    });
    const detection = await detectComicPageLayout({
      imagePath: request.page.imagePath,
      modelPath,
      scoreThreshold: 0.35,
      signal: request.signal,
      decodeFallback: options.decodeFallback,
    });
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
