import type { TranslationOptions } from "../appSettings";
import type { MangaPage } from "../../shared/libraryTypes";
import { buildOverlayBlockId } from "./overlayItems";
import {
  USER_PAGE_FONT_MATCHING_BOUNDARY,
  type FontMatchingPageInferencePort,
  type FontMatchingPageInferenceBlock,
  type FontMatchingPageInferenceResult,
} from "./fontMatchingPagePixelInferenceTypes";
import type { OverlayItem } from "./types";

const EMPTY_PIXEL_INFERENCE = new Map();
export const FONT_MATCHING_PAGE_INFERENCE_TIMEOUT_MS = 90_000;

/**
 * Async page-local producer that runs after bbox validation and before block
 * construction. Errors abstain for the page; cancellation still propagates.
 */
export async function runAutomaticFontMatchingV2PageStage({
  jobId,
  page,
  pageOptions,
  items,
  inferenceBlocks,
  port,
}: {
  jobId: string;
  page: MangaPage;
  pageOptions: TranslationOptions;
  items: readonly OverlayItem[];
  inferenceBlocks?: readonly FontMatchingPageInferenceBlock[];
  port?: FontMatchingPageInferencePort;
}): Promise<FontMatchingPageInferenceResult> {
  const blocks =
    inferenceBlocks ??
    items.map((item, index) => ({
      blockId: buildOverlayBlockId(page.id, jobId, index),
      item,
    }));
  if (
    !pageOptions.autoFontMatching ||
    !port ||
    blocks.length === 0 ||
    !pageOptions.fontMatchingCandidates?.length
  ) {
    return { pixelInferenceByBlockId: EMPTY_PIXEL_INFERENCE };
  }
  try {
    return await inferPageBeforeDeadline({
      port,
      parentSignal: pageOptions.abortSignal,
      request: {
        page,
        blocks,
        candidates: pageOptions.fontMatchingCandidates,
        targetLanguage: pageOptions.targetLanguage,
        boundary: USER_PAGE_FONT_MATCHING_BOUNDARY,
      },
    });
  } catch (error) {
    if (pageOptions.abortSignal?.aborted) throw error;
    return { pixelInferenceByBlockId: EMPTY_PIXEL_INFERENCE };
  }
}

async function inferPageBeforeDeadline({
  port,
  parentSignal,
  request,
}: Readonly<{
  port: FontMatchingPageInferencePort;
  parentSignal?: AbortSignal;
  request: Omit<
    Parameters<FontMatchingPageInferencePort["inferPage"]>[0],
    "signal"
  >;
}>): Promise<FontMatchingPageInferenceResult> {
  const controller = new AbortController();
  const forwardCancellation = (): void => {
    controller.abort(parentSignal?.reason);
  };
  if (parentSignal?.aborted) forwardCancellation();
  else
    parentSignal?.addEventListener("abort", forwardCancellation, {
      once: true,
    });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      const error = new Error("Font matching page inference timed out.");
      controller.abort(error);
      reject(error);
    }, FONT_MATCHING_PAGE_INFERENCE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      port.inferPage({ ...request, signal: controller.signal }),
      deadline,
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    parentSignal?.removeEventListener("abort", forwardCancellation);
  }
}
