import { randomUUID } from "node:crypto";
import type { CodexPageReading } from "../../shared/codexTypesettingTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import { waitForSoundEffectTextReview } from "../application/soundEffectTextReview";
import { translatedPageReading } from "../codexImageEditing";
import type { SoundEffectTranslationJobInput } from "./translationJobTypes";
import type { ValidatedSoundEffectTranslation } from "./soundEffectTranslationResult";
import type { StoredSoundEffectTarget } from "./soundEffectTranslationTargets";

export type DeferredSoundEffectPage = {
  target: StoredSoundEffectTarget;
  items: ValidatedSoundEffectTranslation[];
  pageIndex: number;
  pageTotal: number;
  entries?: { regionId: string; block: TranslationBlock }[];
  reading?: CodexPageReading;
};

export async function reviewSoundEffectImages(
  input: SoundEffectTranslationJobInput,
  pages: readonly DeferredSoundEffectPage[],
  buildEntries: (
    page: DeferredSoundEffectPage,
  ) => Promise<NonNullable<DeferredSoundEffectPage["entries"]>>,
): Promise<void> {
  if (!input.request.codexTypesetting) return;
  const reviewPages = [];
  for (const page of pages) {
    input.abortController.signal.throwIfAborted();
    page.entries = await buildEntries(page);
    if (!page.entries.length) continue;
    const source = page.target.page;
    reviewPages.push({
      pageId: source.id,
      name: source.name,
      imagePath: source.imagePath,
      width: source.width,
      height: source.height,
      reading: translatedPageReading(
        { ...source, blocks: page.entries.map((entry) => entry.block) },
        input.request.codexTypesetting.sfxRendering === "font"
          ? "text"
          : "image",
      ),
    });
  }
  if (!reviewPages.length) return;
  const readings = await waitForSoundEffectTextReview({
    jobId: input.id,
    sessionId: randomUUID(),
    signal: input.abortController.signal,
    pages: reviewPages,
    show: (soundEffectTextReview) =>
      input.emit({
        id: input.id,
        kind: "sound-effect-translation",
        status: "running",
        phase: "model_requesting",
        progressText: "효과음 번역문 확인",
        pageTotal: pages.length,
        soundEffectTextReview,
        codexProgress: {
          stage: "reading",
          step: "confirmText",
          completed: 0,
          total: pages.length,
          page: 1,
        },
      }),
  });
  for (const page of pages) page.reading = readings.get(page.target.page.id);
}
