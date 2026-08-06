import type { TranslationOptions } from "../appSettings";
import type { MangaPage } from "../../shared/libraryTypes";
import { logWarn } from "../logger";
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
    // 추론 포트 단에서 이미 reportWarning을 찍는 경로(워커 클라이언트)도 있지만,
    // 90초 데드라인 타임아웃이나 in-process 포트 예외는 여기까지 전파되므로
    // "왜 조용히 미적용됐나"를 로그에서 추적할 수 있게 한 번 기록한다.
    logWarn("Automatic font matching failed closed for page", {
      pageId: page.id,
      error,
    });
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
