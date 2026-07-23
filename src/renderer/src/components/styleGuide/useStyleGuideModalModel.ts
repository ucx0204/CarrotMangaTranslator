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
import type { WorkContextAnalysisScope } from "../../../../shared/workContextAnalysisTypes";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MAX_TOKENS,
} from "../../../../shared/modelPresets";
import {
  buildWorkContextBudgetPreview,
  WORK_CONTEXT_RECENT_PAGE_COUNT,
} from "../../../../shared/workContextBudget";
import { mangaGateway } from "../../api/mangaGateway";
import { toast } from "../../lib/toastStore";
import type { StyleGuideTab } from "./styleGuideTypes";
import { countAnalysisChanges, normalizeGuideForSave } from "./styleGuideUtils";

type ComponentsT = TFunction<"components">;
export type WorkContextUsageStatus = "loading" | "ready" | "error";

export function useStyleGuideModalModel(
  chapter: ChapterSnapshot,
  settings: AppSettings | null,
) {
  const { i18n, t } = useTranslation("components");
  const [tab, setTab] = React.useState<StyleGuideTab>("glossary");
  const resources = useStyleGuideResources(chapter, t);
  const analysis = useStyleGuideAnalysis({
    chapter,
    t,
    setGuide: resources.setGuide,
    setMemory: resources.setMemory,
    refreshUsage: resources.refreshUsage,
    setTab,
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
      analysis.analyzingScope !== null,
  };
}

function useStyleGuideResources(chapter: ChapterSnapshot, t: ComponentsT) {
  const [guide, setGuide] = React.useState<WorkStyleGuide | null>(null);
  const [memory, setMemory] = React.useState<ChapterStoryMemory | null>(null);
  const [busy, setBusy] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  const { usage, usageStatus, refreshUsage } = useStyleGuideUsage(
    chapter.workId,
  );
  useGuideMemoryLoader({
    chapter,
    t,
    setGuide,
    setMemory,
    setBusy,
  });
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
      toast.success(t("styleGuide.saveSuccess"));
    } catch (error) {
      console.error(error);
      toast.error(t("styleGuide.saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [guide, memory, refreshUsage, t]);
  const resetAllWorkContext = React.useCallback(async () => {
    setResetting(true);
    try {
      const result = await mangaGateway.resetWorkContext({
        chapterId: chapter.id,
      });
      setGuide(result.styleGuide);
      setMemory(result.storyMemory);
      await refreshUsage();
      toast.success(
        t("styleGuide.reset.success", { count: result.resetChapterCount }),
      );
    } catch (error) {
      console.error(error);
      toast.error(t("styleGuide.reset.failed"));
    } finally {
      setResetting(false);
    }
  }, [chapter.id, refreshUsage, t]);
  return {
    guide,
    setGuide,
    memory,
    setMemory,
    usage,
    usageStatus,
    busy,
    saving,
    resetting,
    saveGuide,
    resetAllWorkContext,
    refreshUsage,
  };
}

function useGuideMemoryLoader({
  chapter,
  t,
  setGuide,
  setMemory,
  setBusy,
}: {
  chapter: ChapterSnapshot;
  t: ComponentsT;
  setGuide: React.Dispatch<React.SetStateAction<WorkStyleGuide | null>>;
  setMemory: React.Dispatch<React.SetStateAction<ChapterStoryMemory | null>>;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
}): void {
  React.useEffect(() => {
    let alive = true;
    setBusy(true);
    Promise.all([
      mangaGateway.getWorkStyleGuide(chapter.workId),
      mangaGateway.getChapterStoryMemory(chapter.id),
    ])
      .then(([nextGuide, nextMemory]) => {
        if (alive) {
          setGuide(nextGuide);
          setMemory(nextMemory);
        }
      })
      .catch((error) => {
        console.error(error);
        toast.error(t("styleGuide.loadFailed"));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [chapter.id, chapter.workId, setBusy, setGuide, setMemory, t]);
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

function useStyleGuideAnalysis({
  chapter,
  t,
  setGuide,
  setMemory,
  refreshUsage,
  setTab,
}: {
  chapter: ChapterSnapshot;
  t: TFunction<"components">;
  setGuide: (guide: WorkStyleGuide) => void;
  setMemory: (memory: ChapterStoryMemory) => void;
  refreshUsage: () => Promise<void>;
  setTab: (tab: StyleGuideTab) => void;
}) {
  const [analyzingScope, setAnalyzingScope] =
    React.useState<WorkContextAnalysisScope | null>(null);
  const analyzeWithAi = React.useCallback(
    async (scope: WorkContextAnalysisScope) => {
      setAnalyzingScope(scope);
      try {
        const result = await mangaGateway.analyzeWorkContext({
          chapterId: chapter.id,
          scope,
        });
        setGuide(result.styleGuide);
        setMemory(result.storyMemory);
        await refreshUsage();
        setTab("glossary");
        toast.success(
          t("styleGuide.analysis.success", {
            scope: t(
              scope === "work"
                ? "styleGuide.analysis.entireWork"
                : "styleGuide.analysis.currentChapter",
            ),
            included: result.coverage.includedChapters,
            total: result.coverage.totalChapters,
            changed: countAnalysisChanges(result.counts),
          }),
        );
        result.warnings.slice(0, 2).forEach((warning) => toast.info(warning));
      } catch (error) {
        console.error(error);
        toast.error(t("styleGuide.analysis.failed"));
      } finally {
        setAnalyzingScope(null);
      }
    },
    [chapter.id, refreshUsage, setGuide, setMemory, setTab, t],
  );
  return { analyzingScope, analyzeWithAi };
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
