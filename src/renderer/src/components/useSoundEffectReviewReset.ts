import React from "react";
import { useTranslation } from "react-i18next";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { RestoreSoundEffectReviewRequest } from "../../../shared/analysisTypes";
import {
  buildRestoreSoundEffectReviewRequest,
  restoreSoundEffectDraftPages,
} from "./soundEffectReviewRestoreDraft";
import type { SoundEffectDraftPage } from "./soundEffectTranslationDraftModel";

export function useSoundEffectReviewReset({
  chapter,
  draftPages,
  setDraftPages,
  jobActive,
  onRestore,
}: {
  chapter: ChapterSnapshot;
  draftPages: SoundEffectDraftPage[];
  setDraftPages: React.Dispatch<React.SetStateAction<SoundEffectDraftPage[]>>;
  jobActive: boolean;
  onRestore?: (
    request: RestoreSoundEffectReviewRequest,
  ) => Promise<ChapterSnapshot>;
}) {
  const { t } = useTranslation("components");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [feedback, setFeedback] = React.useState("");
  const running = React.useRef(false);
  const request = React.useMemo(
    () => buildRestoreSoundEffectReviewRequest(chapter.id, draftPages),
    [chapter.id, draftPages],
  );
  const canReset =
    draftPages.some((item) =>
      item.regions.some((region) => region.deleted || !region.included),
    ) || Boolean(onRestore && request.pages.length);
  const reset = async () => {
    if (jobActive || running.current || !canReset) return;
    running.current = true;
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      const latest =
        request.pages.length && onRestore
          ? await onRestore(request)
          : { ...chapter, pages: draftPages.map((item) => item.page) };
      const restored = restoreSoundEffectDraftPages(draftPages, latest);
      const before = draftPages.flatMap((item) =>
        item.regions.filter((region) => !region.deleted && region.included),
      ).length;
      const after = restored.reduce(
        (count, item) => count + item.regions.length,
        0,
      );
      setDraftPages(restored);
      setFeedback(
        t("soundEffectReview.restored", { count: Math.max(0, after - before) }),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("soundEffectReview.restoreFailed"),
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return { busy, canReset, error, feedback, reset };
}
