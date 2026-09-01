import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
  PrepareSoundEffectTranslationRequest,
  StartSoundEffectTranslationRequest,
  StartSoundEffectTranslationResult,
} from "../../../shared/analysisTypes";
import { createSoundEffectReviewPageRevision } from "../../../shared/pageRevision";
import { analysisGateway } from "../api/analysisGateway";
import { libraryGateway } from "../api/libraryGateway";
import type { NotificationPort } from "../lib/notificationPort";
import type {
  TranslationActions,
  UseTranslationActionsOptions,
} from "./translationActionTypes";
import {
  formatTranslationActionError,
  refreshLibraryWithWarning,
} from "./translationActionUtils";

type SoundEffectActionContext = Pick<
  UseTranslationActionsOptions,
  | "beforeTranslate"
  | "currentChapter"
  | "currentChapterRef"
  | "jobActive"
  | "mergeLiveChapter"
  | "pushStatus"
  | "refreshLibrary"
  | "saveNow"
  | "setJobState"
  | "syncSavedPageVersion"
> & {
  notificationPort: NotificationPort;
  t: TFunction<"renderer">;
};

export function useTranslateSoundEffectsAction(
  options: UseTranslationActionsOptions,
  notificationPort: NotificationPort,
): TranslationActions["translateSoundEffects"] {
  const { t } = useTranslation("renderer");
  const context = useMemo<SoundEffectActionContext>(
    () => ({
      beforeTranslate: options.beforeTranslate,
      currentChapter: options.currentChapter,
      currentChapterRef: options.currentChapterRef,
      jobActive: options.jobActive,
      mergeLiveChapter: options.mergeLiveChapter,
      notificationPort,
      pushStatus: options.pushStatus,
      refreshLibrary: options.refreshLibrary,
      saveNow: options.saveNow,
      setJobState: options.setJobState,
      syncSavedPageVersion: options.syncSavedPageVersion,
      t,
    }),
    [notificationPort, options, t],
  );
  return useCallback(
    (
      targets,
      inpaintAfterTranslation = false,
      autoFontMatching = false,
      prepareRequest,
    ) =>
      translateSoundEffects(
        targets,
        inpaintAfterTranslation,
        autoFontMatching,
        prepareRequest,
        context,
      ),
    [context],
  );
}

async function translateSoundEffects(
  targets: StartSoundEffectTranslationRequest["targets"],
  inpaintAfterTranslation: boolean,
  autoFontMatching: boolean,
  prepareRequest: PrepareSoundEffectTranslationRequest | undefined,
  context: SoundEffectActionContext,
): Promise<StartSoundEffectTranslationResult | null> {
  const chapter = context.currentChapter;
  if (
    !chapter ||
    context.jobActive ||
    (targets.length === 0 && !prepareRequest)
  ) {
    return null;
  }
  try {
    return await runSoundEffectTranslation({
      autoFontMatching,
      chapter,
      context,
      inpaintAfterTranslation,
      prepareRequest,
      targets,
    });
  } catch (error) {
    failSoundEffectTranslationJob(
      context,
      context.t("soundEffectTranslation.failed"),
      formatTranslationActionError(
        error,
        context.t("soundEffectTranslation.startFailed"),
      ),
    );
    return null;
  }
}

async function runSoundEffectTranslation({
  autoFontMatching,
  chapter,
  context,
  inpaintAfterTranslation,
  prepareRequest,
  targets,
}: {
  autoFontMatching: boolean;
  chapter: NonNullable<SoundEffectActionContext["currentChapter"]>;
  context: SoundEffectActionContext;
  inpaintAfterTranslation: boolean;
  prepareRequest?: PrepareSoundEffectTranslationRequest;
  targets: StartSoundEffectTranslationRequest["targets"];
}): Promise<StartSoundEffectTranslationResult> {
  const prepared = await prepareSoundEffectTargets(
    chapter,
    targets,
    prepareRequest,
    context,
  );
  if (prepared.completed) {
    await refreshSoundEffectLibrary(context);
    reportResult(prepared.completed, context);
    return prepared.completed;
  }
  context.setJobState({
    id: "pending-sound-effect-translation",
    kind: "sound-effect-translation",
    status: "starting",
    progressText: context.t("soundEffectTranslation.preparing"),
    phase: "booting",
  });
  await context.beforeTranslate?.();
  const result = await analysisGateway.startSoundEffectTranslation({
    chapterId: chapter.id,
    targets: prepared.targets,
    inpaintAfterTranslation,
    autoFontMatching,
  });
  mergeSoundEffectTranslationResult(result, context);
  await refreshSoundEffectLibrary(context);
  reportResult(result, context);
  return result;
}

async function prepareSoundEffectTargets(
  chapter: NonNullable<SoundEffectActionContext["currentChapter"]>,
  targets: StartSoundEffectTranslationRequest["targets"],
  prepareRequest: PrepareSoundEffectTranslationRequest | undefined,
  context: SoundEffectActionContext,
): Promise<{
  targets: StartSoundEffectTranslationRequest["targets"];
  completed?: StartSoundEffectTranslationResult;
}> {
  await context.saveNow();
  const savedChapter = context.currentChapterRef.current;
  const authoritativeChapter =
    savedChapter?.id === chapter.id ? savedChapter : chapter;
  if (!prepareRequest) {
    return { targets: refreshTargetRevisions(authoritativeChapter, targets) };
  }
  const prepared =
    await libraryGateway.prepareSoundEffectTranslation(prepareRequest);
  context.mergeLiveChapter(prepared.chapter);
  for (const page of prepareRequest.pages) {
    context.syncSavedPageVersion(prepared.chapter, page.pageId);
  }
  return prepared.targets.length > 0
    ? { targets: prepared.targets }
    : {
        targets: [],
        completed: {
          status: "completed",
          chapter: prepared.chapter,
          createdBlocksByPage: [],
          translatedRegionCount: 0,
          remainingRegionCount: 0,
        },
      };
}

function mergeSoundEffectTranslationResult(
  result: StartSoundEffectTranslationResult,
  context: SoundEffectActionContext,
): void {
  if (!result.chapter) return;
  context.mergeLiveChapter(result.chapter);
  for (const page of result.createdBlocksByPage) {
    context.syncSavedPageVersion(result.chapter, page.pageId);
  }
}

async function refreshSoundEffectLibrary(
  context: SoundEffectActionContext,
): Promise<void> {
  await refreshLibraryWithWarning(
    context.refreshLibrary,
    context.pushStatus,
    context.t,
    context.notificationPort,
  );
}

function refreshTargetRevisions(
  chapter: NonNullable<SoundEffectActionContext["currentChapter"]>,
  targets: StartSoundEffectTranslationRequest["targets"],
): StartSoundEffectTranslationRequest["targets"] {
  const pages = new Map(chapter.pages.map((page) => [page.id, page]));
  return targets.map((target) => {
    const page = pages.get(target.pageId);
    if (!page) return target;
    return {
      ...target,
      pageRevision: createSoundEffectReviewPageRevision(page),
    };
  });
}

function reportResult(
  result: StartSoundEffectTranslationResult,
  context: SoundEffectActionContext,
): void {
  if (result.status === "failed") {
    failSoundEffectTranslationJob(
      context,
      context.t("soundEffectTranslation.failed"),
      result.error || context.t("soundEffectTranslation.startFailed"),
    );
    return;
  }
  if (result.status === "cancelled") {
    context.pushStatus(context.t("soundEffectTranslation.cancelled"));
    return;
  }
  const partial = result.status === "partial";
  context.setJobState({
    id: "sound-effect-translation-result",
    kind: "sound-effect-translation",
    status: result.status,
    progressText: context.t(
      partial
        ? "soundEffectTranslation.partial"
        : "soundEffectTranslation.completed",
    ),
    phase: partial ? "partial" : "done",
    detail: context.t("soundEffectTranslation.summary", {
      translated: result.translatedRegionCount,
      remaining: result.remainingRegionCount,
    }),
  });
  context.pushStatus(
    context.t("soundEffectTranslation.summary", {
      translated: result.translatedRegionCount,
      remaining: result.remainingRegionCount,
    }),
  );
  for (const warning of result.warnings ?? []) {
    context.pushStatus(warning);
  }
}

function failSoundEffectTranslationJob(
  context: SoundEffectActionContext,
  progressText: string,
  detail: string,
): void {
  context.setJobState({
    id: "failed-sound-effect-translation",
    kind: "sound-effect-translation",
    status: "failed",
    progressText,
    phase: "failed",
    detail,
  });
  context.pushStatus(detail);
}
