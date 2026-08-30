import type { TFunction } from "i18next";
import React from "react";
import type { ChapterSnapshot } from "../../../../shared/libraryTypes";
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
import { handoffActiveModalToWorkCenter } from "../../lib/modalWorkCenterHandoff";
import type { StyleGuideTab } from "./styleGuideTypes";

type StyleGuideResearchInput = {
  chapter: ChapterSnapshot;
  guide: WorkStyleGuide | null;
  t: TFunction<"components">;
  setGuide: React.Dispatch<React.SetStateAction<WorkStyleGuide | null>>;
  setTab: (tab: StyleGuideTab) => void;
  notificationPort: NotificationPort;
};

export function useStyleGuideInternetResearch(input: StyleGuideResearchInput) {
  const [researchEngine, setResearchEngine] = React.useState<ResearchEngine>(
    DEFAULT_RESEARCH_ENGINE,
  );
  const [analyzing, setAnalyzing] = React.useState(false);
  const [proposal, setProposal] =
    React.useState<WorkContextResearchProposal | null>(null);
  const [selectedOperationIds, setSelectedOperationIds] = React.useState<
    Set<string>
  >(new Set());
  const dismissProposal = React.useCallback(() => {
    setProposal(null);
    setSelectedOperationIds(new Set());
  }, []);
  const researchWithInternet = useInternetResearchRunner({
    ...input,
    researchEngine,
    setAnalyzing,
    setProposal,
    setSelectedOperationIds,
  });
  const applySelectedProposal = useResearchProposalApply({
    ...input,
    dismissProposal,
    proposal,
    selectedOperationIds,
  });
  return {
    analyzing,
    proposal,
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
  setSelectedOperationIds: React.Dispatch<React.SetStateAction<Set<string>>>;
};

function useInternetResearchRunner(input: ResearchRunnerInput) {
  const {
    chapter,
    guide,
    notificationPort,
    researchEngine,
    setAnalyzing,
    setProposal,
    setSelectedOperationIds,
    t,
  } = input;
  return React.useCallback(
    async (researchTitle: string) => {
      if (!guide) return;
      const runId = crypto.randomUUID();
      handoffActiveModalToWorkCenter();
      setAnalyzing(true);
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
        setAnalyzing(false);
      }
    },
    [
      chapter.id,
      guide,
      notificationPort,
      researchEngine,
      setAnalyzing,
      setProposal,
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
