import type { TFunction } from "i18next";
import React from "react";
import type { ChapterSnapshot } from "../../../../shared/libraryTypes";
import type {
  JobEvent,
  ResearchJobProgress,
  ResearchJobStage,
} from "../../../../shared/jobTypes";
import {
  DEFAULT_RESEARCH_ENGINE,
  type ResearchEngine,
} from "../../../../shared/internetResearchTypes";
import {
  applyWorkContextResearchOperations,
  createWorkContextResearchFingerprint,
} from "../../../../shared/workContextResearchProposal";
import {
  WORK_CONTEXT_RESEARCH_CANCELLED_ERROR,
  type WorkContextResearchProposal,
} from "../../../../shared/workContextResearchTypes";
import type { WorkStyleGuide } from "../../../../shared/workContextTypes";
import { analysisGateway } from "../../api/analysisGateway";
import type { NotificationPort } from "../../lib/notificationPort";
import type { StyleGuideTab } from "./styleGuideTypes";

type StyleGuideResearchInput = {
  chapter: ChapterSnapshot;
  guide: WorkStyleGuide | null;
  t: TFunction<"components">;
  setGuide: React.Dispatch<React.SetStateAction<WorkStyleGuide | null>>;
  setTab: (tab: StyleGuideTab) => void;
  notificationPort: NotificationPort;
};

type StyleGuideResearchActivity = {
  id: string;
  query: string;
  queryIndex?: number;
  resultCount?: number;
};

export type StyleGuideResearchProgress = {
  runId: string;
  engine: ResearchEngine;
  researchTitle: string;
  startedAt: number;
  stage: ResearchJobStage;
  progressText: string;
  detail?: string;
  metrics?: ResearchJobProgress;
  activities: StyleGuideResearchActivity[];
  cancelling: boolean;
};

export function useStyleGuideInternetResearch(input: StyleGuideResearchInput) {
  const [researchEngine, setResearchEngine] = React.useState<ResearchEngine>(
    DEFAULT_RESEARCH_ENGINE,
  );
  const [analyzing, setAnalyzing] = React.useState(false);
  const [researchRunId, setResearchRunId] = React.useState<string | null>(null);
  const [proposal, setProposal] =
    React.useState<WorkContextResearchProposal | null>(null);
  const [selectedOperationIds, setSelectedOperationIds] = React.useState<
    Set<string>
  >(new Set());
  const progressTracking = useResearchProgressTracking();
  const dismissProposal = React.useCallback(() => {
    setProposal(null);
    setSelectedOperationIds(new Set());
  }, []);
  const researchWithInternet = useInternetResearchRunner({
    ...input,
    researchEngine,
    setAnalyzing,
    setProposal,
    setResearchRunId,
    setSelectedOperationIds,
    beginResearchProgress: progressTracking.begin,
    finishResearchProgress: progressTracking.finish,
  });
  const cancelResearch = useInternetResearchCancellation(
    researchRunId,
    input.t,
    input.notificationPort,
    progressTracking.markCancelling,
  );
  const applySelectedProposal = useResearchProposalApply({
    ...input,
    dismissProposal,
    proposal,
    selectedOperationIds,
  });
  return {
    analyzing,
    cancelResearch,
    proposal,
    researchProgress: progressTracking.progress,
    researchEngine,
    setResearchEngine,
    selectedOperationIds,
    setSelectedOperationIds,
    researchWithInternet,
    dismissProposal,
    applySelectedProposal,
  };
}

type ResearchRunnerInput = Pick<
  StyleGuideResearchInput,
  "chapter" | "guide" | "notificationPort" | "t"
> & {
  researchEngine: ResearchEngine;
  setAnalyzing: React.Dispatch<React.SetStateAction<boolean>>;
  setProposal: React.Dispatch<
    React.SetStateAction<WorkContextResearchProposal | null>
  >;
  setResearchRunId: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedOperationIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  beginResearchProgress: (
    runId: string,
    engine: ResearchEngine,
    researchTitle: string,
  ) => void;
  finishResearchProgress: (runId: string) => void;
};

function useInternetResearchRunner(input: ResearchRunnerInput) {
  const {
    chapter,
    beginResearchProgress,
    finishResearchProgress,
    guide,
    notificationPort,
    researchEngine,
    setAnalyzing,
    setProposal,
    setResearchRunId,
    setSelectedOperationIds,
    t,
  } = input;
  return React.useCallback(
    async (researchTitle: string) => {
      if (!guide) return;
      const runId = crypto.randomUUID();
      setAnalyzing(true);
      setResearchRunId(runId);
      beginResearchProgress(runId, researchEngine, researchTitle);
      setProposal(null);
      setSelectedOperationIds(new Set());
      try {
        const result = await analysisGateway.researchWorkContext({
          runId,
          chapterId: chapter.id,
          researchTitle,
          engine: researchEngine,
          guideSnapshot: guide,
        });
        setProposal(result);
        setSelectedOperationIds(defaultSelectedIds(result));
        notificationPort.success(
          t("styleGuide.research.previewReady", {
            count: result.operations.length,
          }),
        );
      } catch (error) {
        reportResearchError(error, t, notificationPort);
      } finally {
        finishResearchProgress(runId);
        setAnalyzing(false);
        setResearchRunId(null);
      }
    },
    [
      chapter.id,
      beginResearchProgress,
      finishResearchProgress,
      guide,
      notificationPort,
      researchEngine,
      setAnalyzing,
      setProposal,
      setResearchRunId,
      setSelectedOperationIds,
      t,
    ],
  );
}

function defaultSelectedIds(result: WorkContextResearchProposal): Set<string> {
  return new Set(
    result.operations
      .filter((operation) => operation.selectedByDefault)
      .map((operation) => operation.id),
  );
}

function reportResearchError(
  error: unknown,
  t: TFunction<"components">,
  notificationPort: NotificationPort,
): void {
  console.error(error);
  const message = error instanceof Error ? error.message : "";
  if (message.includes(WORK_CONTEXT_RESEARCH_CANCELLED_ERROR)) {
    notificationPort.info(t("styleGuide.research.cancelled"));
    return;
  }
  notificationPort.error(message || t("styleGuide.research.failed"));
}

function useInternetResearchCancellation(
  researchRunId: string | null,
  t: TFunction<"components">,
  notificationPort: NotificationPort,
  markCancelling: (runId: string) => void,
) {
  return React.useCallback(async () => {
    if (!researchRunId) return;
    markCancelling(researchRunId);
    try {
      await analysisGateway.cancelWorkContextResearch(researchRunId);
    } catch (error) {
      console.error(error);
      notificationPort.error(t("styleGuide.research.cancelFailed"));
    }
  }, [markCancelling, notificationPort, researchRunId, t]);
}

function useResearchProgressTracking(): {
  progress: StyleGuideResearchProgress | null;
  begin: (runId: string, engine: ResearchEngine, researchTitle: string) => void;
  finish: (runId: string) => void;
  markCancelling: (runId: string) => void;
} {
  const activeJobIdRef = React.useRef<string | null>(null);
  const [progress, setProgress] =
    React.useState<StyleGuideResearchProgress | null>(null);
  React.useEffect(
    () =>
      analysisGateway.onJobEvent((event) => {
        if (event.id !== activeJobIdRef.current) return;
        setProgress((current) =>
          current ? mergeStyleGuideResearchProgress(current, event) : current,
        );
      }),
    [],
  );
  const begin = React.useCallback(
    (runId: string, engine: ResearchEngine, researchTitle: string) => {
      activeJobIdRef.current = `work-context-research-${runId}`;
      setProgress({
        runId,
        engine,
        researchTitle,
        startedAt: Date.now(),
        stage: "preparing",
        progressText: "",
        activities: [],
        cancelling: false,
      });
    },
    [],
  );
  const finish = React.useCallback((runId: string) => {
    if (activeJobIdRef.current !== `work-context-research-${runId}`) return;
    activeJobIdRef.current = null;
    setProgress(null);
  }, []);
  const markCancelling = React.useCallback((runId: string) => {
    setProgress((current) =>
      current?.runId === runId ? { ...current, cancelling: true } : current,
    );
  }, []);
  return { progress, begin, finish, markCancelling };
}

export function mergeStyleGuideResearchProgress(
  current: StyleGuideResearchProgress,
  event: JobEvent,
): StyleGuideResearchProgress {
  const metrics = event.research ?? current.metrics;
  return {
    ...current,
    stage: metrics?.stage ?? current.stage,
    progressText: event.progressText,
    detail: event.detail,
    metrics,
    activities: metrics?.query
      ? upsertResearchActivity(current.activities, metrics)
      : current.activities,
    cancelling: current.cancelling || event.status === "cancelling",
  };
}

function upsertResearchActivity(
  activities: readonly StyleGuideResearchActivity[],
  metrics: ResearchJobProgress,
): StyleGuideResearchActivity[] {
  const query = metrics.query?.trim();
  if (!query) return [...activities];
  const id = `${metrics.queryIndex ?? "query"}:${query}`;
  const next: StyleGuideResearchActivity = {
    id,
    query,
    queryIndex: metrics.queryIndex,
    resultCount: metrics.resultCount,
  };
  const existingIndex = activities.findIndex((item) => item.id === id);
  const merged =
    existingIndex >= 0
      ? activities.map((item, index) => (index === existingIndex ? next : item))
      : [...activities, next];
  return merged.slice(-5);
}

function useResearchProposalApply({
  guide,
  notificationPort,
  proposal,
  selectedOperationIds,
  setGuide,
  setTab,
  t,
  dismissProposal,
}: Pick<
  StyleGuideResearchInput,
  "guide" | "notificationPort" | "setGuide" | "setTab" | "t"
> & {
  proposal: WorkContextResearchProposal | null;
  selectedOperationIds: Set<string>;
  dismissProposal: () => void;
}) {
  return React.useCallback(() => {
    if (!guide || !proposal) return;
    if (
      createWorkContextResearchFingerprint(guide) !== proposal.baseFingerprint
    ) {
      notificationPort.error(t("styleGuide.research.stale"));
      return;
    }
    const selected = proposal.operations.filter((operation) =>
      selectedOperationIds.has(operation.id),
    );
    setGuide(applyWorkContextResearchOperations(guide, selected));
    setTab(resolveAppliedTab(selected));
    dismissProposal();
    notificationPort.success(
      t("styleGuide.research.applied", { count: selected.length }),
    );
  }, [
    dismissProposal,
    guide,
    notificationPort,
    proposal,
    selectedOperationIds,
    setGuide,
    setTab,
    t,
  ]);
}

function resolveAppliedTab(
  selected: WorkContextResearchProposal["operations"],
): StyleGuideTab {
  return selected.length > 0 &&
    selected.every((operation) => operation.entity === "character")
    ? "characters"
    : "glossary";
}
