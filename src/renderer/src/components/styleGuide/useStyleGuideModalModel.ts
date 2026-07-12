import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "../../../../shared/settingsTypes";
import type { ChapterSnapshot } from "../../../../shared/libraryTypes";
import type {
  ChapterStoryMemory,
  WorkStyleGuide,
} from "../../../../shared/workContextTypes";
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
    setTab,
  });
  return {
    ...resources,
    ...analysis,
    tab,
    setTab,
    locale: i18n.resolvedLanguage ?? i18n.language,
    budget: useStyleGuideBudget(resources.guide, resources.memory, settings),
    working: resources.busy || analysis.analyzingScope !== null,
  };
}

function useStyleGuideResources(
  chapter: ChapterSnapshot,
  t: TFunction<"components">,
) {
  const [guide, setGuide] = React.useState<WorkStyleGuide | null>(null);
  const [memory, setMemory] = React.useState<ChapterStoryMemory | null>(null);
  const [busy, setBusy] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
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
  }, [chapter.id, chapter.workId, t]);
  const saveGuide = React.useCallback(async () => {
    if (!guide) return;
    setSaving(true);
    try {
      const saved = await mangaGateway.saveWorkStyleGuide(
        normalizeGuideForSave(guide),
      );
      setGuide(saved);
      toast.success(t("styleGuide.saveSuccess"));
    } catch (error) {
      console.error(error);
      toast.error(t("styleGuide.saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [guide, t]);
  return { guide, setGuide, memory, setMemory, busy, saving, saveGuide };
}

function useStyleGuideAnalysis({
  chapter,
  t,
  setGuide,
  setMemory,
  setTab,
}: {
  chapter: ChapterSnapshot;
  t: TFunction<"components">;
  setGuide: (guide: WorkStyleGuide) => void;
  setMemory: (memory: ChapterStoryMemory) => void;
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
    [chapter.id, setGuide, setMemory, setTab, t],
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
