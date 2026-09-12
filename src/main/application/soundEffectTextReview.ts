import type { CodexPageReading } from "../../shared/codexTypesettingTypes";
import {
  confirmSoundEffectTextReviewSchema,
  type ConfirmSoundEffectTextReview,
  type SoundEffectTextReview,
} from "../../shared/soundEffectTextReview";
import { applyRegionTextReview } from "./regionTextReview";

type ReviewPage = Omit<SoundEffectTextReview["pages"][number], "review"> & {
  reading: CodexPageReading;
};
type Pending = {
  sessionId: string;
  pages: ReviewPage[];
  resolve: (readings: Map<string, CodexPageReading>) => void;
};
const pending = new Map<string, Pending>();

export async function waitForSoundEffectTextReview(options: {
  jobId: string;
  sessionId: string;
  pages: ReviewPage[];
  signal: AbortSignal;
  show: (review: SoundEffectTextReview) => void;
}): Promise<Map<string, CodexPageReading>> {
  const { jobId, sessionId, pages, signal } = options;
  signal.throwIfAborted();
  if (pending.has(jobId))
    throw new Error("이미 효과음 번역문을 확인하고 있습니다.");
  let cancel = () => {};
  try {
    return await new Promise((resolve, reject) => {
      cancel = () =>
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      pending.set(jobId, { sessionId, pages, resolve });
      signal.addEventListener("abort", cancel, { once: true });
      options.show({
        sessionId,
        pages: pages.map(({ reading, ...page }) => ({
          ...page,
          review: {
            sessionId,
            regions: reading.regions
              .filter((region) => region.action !== "keep")
              .map(
                ({
                  id,
                  sourceText,
                  translatedText,
                  sourceBbox,
                  styleGroupId,
                }) => ({
                  id,
                  sourceText,
                  translatedText,
                  sourceBbox,
                  styleGroupId,
                }),
              ),
          },
        })),
      });
    });
  } finally {
    pending.delete(jobId);
    signal.removeEventListener("abort", cancel);
  }
}

export function confirmSoundEffectTextReview(
  input: ConfirmSoundEffectTextReview,
): boolean {
  const request = confirmSoundEffectTextReviewSchema.parse(input);
  const review = pending.get(request.jobId);
  if (!review || review.sessionId !== request.sessionId)
    throw new Error("효과음 번역문 확인이 만료되었습니다. 다시 시작해 주세요.");
  const pages = new Map(request.pages.map((page) => [page.pageId, page]));
  if (pages.size !== request.pages.length || pages.size !== review.pages.length)
    throw new Error("확인한 페이지 목록이 번역 결과와 다릅니다.");
  const readings = new Map(
    review.pages.map((page) => {
      const value = pages.get(page.pageId);
      if (!value) throw new Error("확인한 페이지 목록이 번역 결과와 다릅니다.");
      return [page.pageId, applyRegionTextReview(page.reading, value)] as const;
    }),
  );
  review.resolve(readings);
  pending.delete(request.jobId);
  return true;
}
