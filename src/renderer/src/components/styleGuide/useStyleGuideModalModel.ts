import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "../../../../shared/settingsTypes";
import type { ChapterSnapshot } from "../../../../shared/libraryTypes";
import type {
  ChapterStoryMemory,
  WorkStyleGuide,
} from "../../../../shared/workContextTypes";
import type { WorkContextUsage } from "../../../../shared/workContextUsageTypes";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MAX_TOKENS,
} from "../../../../shared/modelPresets";
import {
  buildWorkContextBudgetPreview,
  WORK_CONTEXT_RECENT_PAGE_COUNT,
} from "../../../../shared/workContextBudget";
import { libraryGateway as mangaGateway } from "../../api/libraryGateway";
import type { NotificationPort } from "../../lib/notificationPort";
import type { StyleGuideTab } from "./styleGuideTypes";
import { normalizeGuideForSave } from "./styleGuideUtils";
import { useStyleGuideInternetResearch } from "./useStyleGuideInternetResearch";

type ComponentsT = TFunction<"components">;
export type WorkContextUsageStatus = "loading" | "ready" | "error";

export function useStyleGuideModalModel(
  chapter: ChapterSnapshot,
  workTitle: string,
  settings: AppSettings | null,
  notificationPort: NotificationPort,
) {
  const { i18n, t } = useTranslation("components");
  const [tab, setTab] = React.useState<StyleGuideTab>("glossary");
  const resources = useStyleGuideResources(
    chapter,
    workTitle,
    t,
    notificationPort,
  );
  const analysis = useStyleGuideInternetResearch({
    chapter,
    guide: resources.guide,
    t,
    setGuide: resources.setGuide,
    setTab,
    notificationPort,
  });
  return {
    ...resources,
    ...analysis,
    tab,
    setTab,
    locale: i18n.resolvedLanguage ?? i18n.language,
    budget: useStyleGuideBudget(resources.guide, resources.memory, settings),
    working:
      resources.busy ||
      resources.saving ||
      resources.resetting ||
      analysis.analyzing,
  };
}

function useStyleGuideResources(
  chapter: ChapterSnapshot,
  workTitle: string,
  t: ComponentsT,
  notificationPort: NotificationPort,
) {
  const [guide, setGuide] = React.useState<WorkStyleGuide | null>(null);
  const [memory, setMemory] = React.useState<ChapterStoryMemory | null>(null);
  const [researchTitle, setResearchTitle] = React.useState(workTitle);
  const [busy, setBusy] = React.useState(true);
  const { usage, usageStatus, refreshUsage } = useStyleGuideUsage(
    chapter.workId,
  );
  useGuideMemoryLoader({
    chapter,
    workTitle,
    t,
    setGuide,
    setMemory,
    setResearchTitle,
    setBusy,
    notificationPort,
  });
  const saveResearchTitle = React.useCallback(
    async (nextTitle: string) => {
      const saved = await mangaGateway.saveWorkResearchTitle({
        workId: chapter.workId,
        researchTitle: nextTitle,
      });
      setResearchTitle(saved.researchTitle);
      return saved.researchTitle;
    },
    [chapter.workId],
  );
  const mutations = useStyleGuideResourceMutations({
    chapter,
    guide,
    memory,
    notificationPort,
    refreshUsage,
    setGuide,
    setMemory,
    t,
  });
  return {
    guide,
    setGuide,
    memory,
    setMemory,
    researchTitle,
    saveResearchTitle,
    usage,
    usageStatus,
    busy,
    ...mutations,
    refreshUsage,
  };
}

function useStyleGuideResourceMutations({
  chapter,
  guide,
  memory,
  notificationPort,
  refreshUsage,
  setGuide,
  setMemory,
  t,
}: {
  chapter: ChapterSnapshot;
  guide: WorkStyleGuide | null;
  memory: ChapterStoryMemory | null;
  notificationPort: NotificationPort;
  refreshUsage: () => Promise<void>;
  setGuide: React.Dispatch<React.SetStateAction<WorkStyleGuide | null>>;
  setMemory: React.Dispatch<React.SetStateAction<ChapterStoryMemory | null>>;
  t: ComponentsT;
}) {
  const [saving, setSaving] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  const saveGuide = React.useCallback(async () => {
    if (!guide) return;
    setSaving(true);
    try {
      const savedGuide = await mangaGateway.saveWorkStyleGuide(
        normalizeGuideForSave(guide),
      );
      const savedMemory = memory
        ? await mangaGateway.saveChapterStoryMemory(memory)
        : null;
      setGuide(savedGuide);
      if (savedMemory) setMemory(savedMemory);
      await refreshUsage();
      notificationPort.success(t("styleGuide.saveSuccess"));
    } catch (error) {
      console.error(error);
      notificationPort.error(t("styleGuide.saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [guide, memory, notificationPort, refreshUsage, setGuide, setMemory, t]);
  const resetAllWorkContext = React.useCallback(async () => {
    setResetting(true);
    try {
      const result = await mangaGateway.resetWorkContext({
        chapterId: chapter.id,
      });
      setGuide(result.styleGuide);
      setMemory(result.storyMemory);
      await refreshUsage();
      notificationPort.success(
        t("styleGuide.reset.success", { count: result.resetChapterCount }),
      );
    } catch (error) {
      console.error(error);
      notificationPort.error(t("styleGuide.reset.failed"));
    } finally {
      setResetting(false);
    }
  }, [chapter.id, notificationPort, refreshUsage, setGuide, setMemory, t]);
  return { resetAllWorkContext, resetting, saveGuide, saving };
}

function useGuideMemoryLoader({
  chapter,
  workTitle,
  t,
  setGuide,
  setMemory,
  setResearchTitle,
  setBusy,
  notificationPort,
}: {
  chapter: ChapterSnapshot;
  workTitle: string;
  t: ComponentsT;
  setGuide: React.Dispatch<React.SetStateAction<WorkStyleGuide | null>>;
  setMemory: React.Dispatch<React.SetStateAction<ChapterStoryMemory | null>>;
  setResearchTitle: React.Dispatch<React.SetStateAction<string>>;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  notificationPort: NotificationPort;
}): void {
  React.useEffect(() => {
    let alive = true;
    setBusy(true);
    Promise.all([
      mangaGateway.getWorkStyleGuide(chapter.workId),
      mangaGateway.getChapterStoryMemory(chapter.id),
      mangaGateway.getWorkResearchTitle(chapter.workId),
    ])
      .then(([nextGuide, nextMemory, titlePreference]) => {
        if (alive) {
          setGuide(nextGuide);
          setMemory(nextMemory);
          setResearchTitle(titlePreference?.researchTitle ?? workTitle);
        }
      })
      .catch((error) => {
        console.error(error);
        notificationPort.error(t("styleGuide.loadFailed"));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [
    chapter.id,
    chapter.workId,
    notificationPort,
    setBusy,
    setGuide,
    setMemory,
    setResearchTitle,
    t,
    workTitle,
  ]);
}

function useStyleGuideUsage(workId: string): {
  usage: WorkContextUsage | null;
  usageStatus: WorkContextUsageStatus;
  refreshUsage: () => Promise<void>;
} {
  const [usage, setUsage] = React.useState<WorkContextUsage | null>(null);
  const [usageStatus, setUsageStatus] =
    React.useState<WorkContextUsageStatus>("loading");
  const latestRequestId = React.useRef(0);
  const fetchUsage = React.useCallback(
    () => mangaGateway.getWorkContextUsage(workId),
    [workId],
  );
  const refreshUsage = React.useCallback(async () => {
    const requestId = ++latestRequestId.current;
    setUsageStatus("loading");
    try {
      const nextUsage = await fetchUsage();
      if (requestId !== latestRequestId.current) return;
      setUsage(nextUsage);
      setUsageStatus("ready");
    } catch (error) {
      console.error(error);
      if (requestId !== latestRequestId.current) return;
      setUsage(null);
      setUsageStatus("error");
    }
  }, [fetchUsage]);
  React.useEffect(() => {
    let alive = true;
    const requestId = ++latestRequestId.current;
    setUsage(null);
    setUsageStatus("loading");
    void fetchUsage()
      .then((nextUsage) => {
        if (alive && requestId === latestRequestId.current) {
          setUsage(nextUsage);
          setUsageStatus("ready");
        }
      })
      .catch((error) => {
        console.error(error);
        if (alive && requestId === latestRequestId.current) {
          setUsage(null);
          setUsageStatus("error");
        }
      });
    return () => {
      alive = false;
    };
  }, [fetchUsage]);
  return { usage, usageStatus, refreshUsage };
}

function useStyleGuideBudget(
  guide: WorkStyleGuide | null,
  memory: ChapterStoryMemory | null,
  settings: AppSettings | null,
) {
  return React.useMemo(
    () =>
      guide && memory
        ? buildWorkContextBudgetPreview({
            ctx: settings?.ctx ?? DEFAULT_CONTEXT_TOKENS,
            maxTokens: settings?.maxTokens ?? DEFAULT_MAX_TOKENS,
            recentPageCount: WORK_CONTEXT_RECENT_PAGE_COUNT,
            storyMemory: memory,
            styleGuide: guide,
          })
        : null,
    [guide, memory, settings?.ctx, settings?.maxTokens],
  );
}
