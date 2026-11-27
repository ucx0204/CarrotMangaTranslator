import {
  prepareCudaContext,
  resolvePreparedContext,
} from "./preparedContextualText";
import { completePaperOwners } from "../inpainting/qwenPaperOwnership";
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
import { ensureKoharuLayoutAssets } from "./assets";
import { detectKoharuPageLayout } from "./detector";
import { loadPageImage } from "../inpainting/imageIO";
import { completeDetectedQwenPrintEdges } from "../inpainting/qwenDetectedPrintEdge";
import {
  contextualTextTargets,
  refineContextualText,
} from "../inpainting/qwenContextualTypography";
import { disposeCachedKoharuLayoutSessions } from "./session";
import { PreparedLayoutDetections } from "./preparedLayoutDetections";
import type { MangaPage } from "../../shared/libraryTypes";
import type { ComicPageDetectionResult } from "./contracts";
import {
  processDetectedBubbleLayouts,
  resolveBubbleLayoutBlockRevision,
} from "./bubbleLayoutPageProcessor";

type DetectionCache = {
  entries: Map<
    string,
    { promise: Promise<ComicPageDetectionResult>; bytes: number }
  >;
  bytes: number;
  prepared?: PreparedLayoutDetections;
};
const MAX_DETECTION_CACHE_BYTES = 64 * 1024 * 1024;

export function createProductionBubbleLayoutRunner(
  options: BubbleLayoutRunnerFactoryOptions,
): BubbleLayoutRunner {
  const detectionsByOriginalPath: DetectionCache = {
    entries: new Map(),
    bytes: 0,
  };
  return {
    preparePages: async (pages, signal, onProgress) => {
      detectionsByOriginalPath.entries.clear();
      detectionsByOriginalPath.bytes = 0;
      const prepared = (detectionsByOriginalPath.prepared ??=
        new PreparedLayoutDetections());
      await prepared.prepare(
        pages,
        signal,
        async (page) => {
          const detection = await detectOriginalPageLayoutUncached(
            options,
            page,
            signal,
          );
          return options.prepareQwenContext &&
            detection.executionProvider === "cuda"
            ? prepareCudaContext(page, detection, options, signal)
            : detection;
        },
        disposeCachedKoharuLayoutSessions,
        onProgress,
      );
    },
    dispose: async () => {
      detectionsByOriginalPath.entries.clear();
      detectionsByOriginalPath.bytes = 0;
      await detectionsByOriginalPath.prepared?.dispose();
    },
    runPage: (request) =>
      runProductionBubbleLayout(options, request, detectionsByOriginalPath),
  };
}

async function runProductionBubbleLayout(
  options: BubbleLayoutRunnerFactoryOptions,
  request: BubbleLayoutRunnerRequest,
  detectionsByOriginalPath: DetectionCache,
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
    throwIfAborted(request.signal);
    const detectedPatches = processDetectedBubbleLayouts({
      page: request.page,
      imageWidth: detection.imageWidth,
      imageHeight: detection.imageHeight,
      detections: detection.detections,
      policy: request.policy,
      paddingRatio: request.paddingRatio,
      sharedOwnershipGapPx: request.sharedOwnershipGapPx,
      sourceEraseMask: request.sourceEraseMask,
      pageRevision,
    });
    return await prepareEraseResult(
      options,
      request,
      detection,
      detectedPatches,
    );
  } catch (error) {
    if (request.signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const failureIsRequired =
      !!detectionsByOriginalPath.prepared ||
      request.failureMode !== "best-effort";
    logWarn(
      failureIsRequired
        ? "Bubble-aware layout postprocess failed"
        : "Bubble-aware layout postprocess skipped",
      {
        pageId: request.page.id,
        error,
      },
    );
    if (failureIsRequired) {
      throw error;
    }
    return {
      patches: clearStaleGeneratedLayouts(request, pageRevision),
    };
  }
}

async function prepareEraseResult(
  options: BubbleLayoutRunnerFactoryOptions,
  request: BubbleLayoutRunnerRequest,
  detection: ComicPageDetectionResult,
  detectedPatches: ReturnType<typeof processDetectedBubbleLayouts>,
): Promise<BubbleLayoutRunnerResult> {
  let original: ReturnType<typeof loadPageImage> | undefined;
  const loadOriginal = () =>
    (original ??= loadPageImage(
      request.page.imagePath,
      options.decodeFallback,
    ));
  const patches = await resolveSourceEraseEdges(
    request,
    detection,
    detectedPatches,
    loadOriginal,
  );
  const contextualText = await resolveContextualText(
    options,
    request,
    detection,
    patches,
    loadOriginal,
  );
  return {
    patches,
    ...(request.includeTypographySegmentation
      ? {
          typographySegmentation: {
            imageWidth: detection.imageWidth,
            imageHeight: detection.imageHeight,
            detections: detection.detections,
            ...(contextualText?.size ? { contextualText } : {}),
          },
        }
      : {}),
  };
}

async function resolveContextualText(
  options: BubbleLayoutRunnerFactoryOptions,
  request: BubbleLayoutRunnerRequest,
  detection: ComicPageDetectionResult,
  patches: ReturnType<typeof processDetectedBubbleLayouts>,
  loadOriginal: () => ReturnType<typeof loadPageImage>,
) {
  if (
    request.includeTypographySegmentation !== "qwen-print" ||
    detection.imageWidth !== request.page.width ||
    detection.imageHeight !== request.page.height
  )
    return;
  const targets = contextualTextTargets(
    request.page,
    detection,
    patches,
    request.targetBlockIds,
  );
  if (!targets.length) return;
  try {
    return await resolvePreparedContext(
      targets,
      detection.preparedText,
      async (missing) => {
        const source = await loadOriginal();
        const assets = await ensureKoharuLayoutAssets({
          dataRoot: options.dataRoot,
          signal: request.signal,
        });
        return refineContextualText(
          request.page,
          missing,
          (view) =>
            detectKoharuPageLayout({
              imagePath: request.page.imagePath,
              originalCrop: source.crop(view),
              modelPath: assets.modelPath,
              providerPreference: ["cpu"],
              signal: request.signal,
            }),
          request.signal,
        );
      },
    );
  } catch (error) {
    request.signal.throwIfAborted();
    logWarn("Koharu contextual text refinement skipped", {
      pageId: request.page.id,
      error,
    });
    return;
  }
}

async function resolveSourceEraseEdges(
  request: BubbleLayoutRunnerRequest,
  detection: ComicPageDetectionResult,
  patches: ReturnType<typeof processDetectedBubbleLayouts>,
  loadOriginal: () => ReturnType<typeof loadPageImage>,
) {
  if (
    request.includeTypographySegmentation !== "qwen-print" ||
    !patches.some((patch) => patch.sourceEraseConstraint)
  )
    return patches;
  const source = await loadOriginal();
  throwIfAborted(request.signal);
  const { width, height } = source.getSize();
  if (width !== detection.imageWidth || height !== detection.imageHeight)
    return patches;
  const bitmap = source.toBitmap();
  const owners = completePaperOwners(
    request.page,
    patches,
    bitmap,
    request.signal,
    request.targetBlockIds,
  );
  return completeDetectedQwenPrintEdges(
    request.page,
    owners,
    detection,
    bitmap,
    request.signal,
    request.targetBlockIds,
  );
}

async function detectOriginalPageLayout(
  options: BubbleLayoutRunnerFactoryOptions,
  request: BubbleLayoutRunnerRequest,
  cache: DetectionCache,
): Promise<ComicPageDetectionResult> {
  const originalPath = request.page.imagePath;
  if (cache.prepared) return cache.prepared.read(originalPath);
  const source = await stat(originalPath);
  const key = `${originalPath}:${source.size}:${source.mtimeMs}:${source.ctimeMs}`;
  const cached = cache.entries.get(key);
  if (cached) return cached.promise;
  const detection = detectOriginalPageLayoutUncached(
    options,
    request.page,
    request.signal,
  );
  if (cache.entries.size >= 128) return detection;
  const entry = { promise: detection, bytes: 0 };
  cache.entries.set(key, entry);
  try {
    const result = await detection;
    const bytes = result.detections.reduce(
      (total, item) => total + 256 + (item.mask?.logits.byteLength ?? 0),
      256,
    );
    if (cache.bytes + bytes > MAX_DETECTION_CACHE_BYTES)
      cache.entries.delete(key);
    else {
      entry.bytes = bytes;
      cache.bytes += bytes;
    }
    return result;
  } catch (error) {
    cache.entries.delete(key);
    throw error;
  }
}

async function detectOriginalPageLayoutUncached(
  options: BubbleLayoutRunnerFactoryOptions,
  page: MangaPage,
  signal: AbortSignal,
): Promise<ComicPageDetectionResult> {
  const detectorAssets = await ensureKoharuLayoutAssets({
    dataRoot: options.dataRoot,
    signal,
  });
  return detectKoharuPageLayout({
    imagePath: page.imagePath,
    modelPath: detectorAssets.modelPath,
    directMl: options.directMl,
    signal,
    decodeFallback: options.decodeFallback,
  });
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
