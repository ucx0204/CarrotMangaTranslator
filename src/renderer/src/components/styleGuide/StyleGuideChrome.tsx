import React from "react";
import { useTranslation } from "react-i18next";
import type {
  ChapterStoryMemory,
  WorkStyleGuide,
} from "../../../../shared/workContextTypes";
import type { ResearchEngine } from "../../../../shared/internetResearchTypes";
import type { WorkContextBudgetPlan } from "../../../../shared/workContextBudget";
import type { WorkContextUsage } from "../../../../shared/workContextUsageTypes";
import type { WorkContextUsageStatus } from "./useStyleGuideModalModel";
import { Button } from "../ui/Button";
import { Tabs } from "../ui/Tabs";
import { SegmentedControl } from "../ui/SegmentedControl";
import { CharactersTab } from "./CharactersTab";
import { GlossaryTab } from "./GlossaryTab";
import { MemoryTab } from "./MemoryTab";
import { RulesTab } from "./RulesTab";
import type { StyleGuideTab } from "./styleGuideTypes";
import { buildBudgetWarningText, formatTokenCount } from "./styleGuideUtils";

export function StyleGuideTabContent({
  busy,
  guide,
  memory,
  onGuideChange,
  onMemoryChange,
  tab,
  usage,
  usageStatus = usage ? "ready" : "loading",
}: {
  busy: boolean;
  guide: WorkStyleGuide | null;
  memory: ChapterStoryMemory | null;
  onGuideChange: (guide: WorkStyleGuide) => void;
  onMemoryChange: (memory: ChapterStoryMemory) => void;
  tab: StyleGuideTab;
  usage: WorkContextUsage | null;
  usageStatus?: WorkContextUsageStatus;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const [glossaryDraftId, setGlossaryDraftId] = React.useState<string | null>(
    null,
  );
  const [characterDraftId, setCharacterDraftId] = React.useState<string | null>(
    null,
  );
  const panelId = `style-guide-panel-${tab}`;
  const tabId = `style-guide-tab-${tab}`;
  if (busy || !guide) {
    return (
      <div
        className="style-guide-tabpanel"
        id={panelId}
        role="tabpanel"
        aria-labelledby={tabId}
      >
        <p className="muted-line style-guide-empty">{t("common.loading")}</p>
      </div>
    );
  }
  const editors = {
    glossary: (
      <GlossaryTab
        guide={guide}
        onGuideChange={onGuideChange}
        draftId={glossaryDraftId}
        onDraftIdChange={setGlossaryDraftId}
        usage={usage?.glossary ?? []}
        usageAvailable={usageStatus !== "error"}
      />
    ),
    characters: (
      <CharactersTab
        guide={guide}
        onGuideChange={onGuideChange}
        draftId={characterDraftId}
        onDraftIdChange={setCharacterDraftId}
        usage={usage?.characters ?? []}
        usageAvailable={usageStatus !== "error"}
      />
    ),
    rules: <RulesTab guide={guide} onGuideChange={onGuideChange} />,
    memory: <MemoryTab memory={memory} onMemoryChange={onMemoryChange} />,
  } satisfies Record<StyleGuideTab, React.JSX.Element>;
  return (
    <div
      className="style-guide-tabpanel"
      id={panelId}
      role="tabpanel"
      aria-labelledby={tabId}
    >
      {editors[tab]}
    </div>
  );
}

export function StyleGuideBudgetSummary({
  budget,
  locale,
}: {
  budget: WorkContextBudgetPlan | null;
  locale: string;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  if (!budget) {
    return <span className="style-guide-budget-placeholder" />;
  }
  return (
    <div className="style-guide-budget" aria-live="polite">
      <div className="style-guide-budget-main">
        <strong>
          {t("styleGuide.budget.total", {
            tokens: formatTokenCount(budget.original.totalTokens, locale, t),
          })}
        </strong>
        <span>
          {t("styleGuide.budget.outputHeadroom", {
            percent: budget.original.outputHeadroomPercent,
          })}
        </span>
      </div>
      <div className="style-guide-budget-detail">
        {t("styleGuide.budget.breakdown", {
          story: formatTokenCount(budget.original.storyMemoryTokens, locale, t),
          glossary: formatTokenCount(budget.original.glossaryTokens, locale, t),
          characters: formatTokenCount(
            budget.original.characterTokens,
            locale,
            t,
          ),
        })}
      </div>
      {budget.omittedParts.length ? (
        <p className="style-guide-budget-warning">
          {buildBudgetWarningText(budget, locale, t)}
        </p>
      ) : null}
    </div>
  );
}

export function StyleGuideAnalysisActions({
  analyzing,
  disabled,
  engine,
  onEngineChange,
  onAnalyze,
}: {
  analyzing: boolean;
  disabled: boolean;
  engine: ResearchEngine;
  onEngineChange: (engine: ResearchEngine) => void;
  onAnalyze: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section
      className="style-guide-analysis"
      aria-label={t("styleGuide.analysis.ariaLabel")}
    >
      <div className="style-guide-analysis-info">
        <h3>{t("styleGuide.analysis.title")}</h3>
        <p>{t("styleGuide.analysis.description")}</p>
      </div>
      <div className="style-guide-analysis-controls">
        <div className="style-guide-analysis-engine">
          <span>{t("styleGuide.analysis.engineLabel")}</span>
          <SegmentedControl
            ariaLabel={t("styleGuide.analysis.engineLabel")}
            singleRow
            value={engine}
            disabled={disabled}
            options={[
              {
                id: "tavily",
                label: t("styleGuide.analysis.engines.tavily"),
              },
              {
                id: "codex-web",
                label: t("styleGuide.analysis.engines.codex"),
              },
            ]}
            onChange={onEngineChange}
          />
        </div>
        <div className="style-guide-analysis-actions">
          <Button
            variant="primary"
            disabled={disabled}
            aria-busy={analyzing}
            onClick={() => onAnalyze()}
          >
            {t(
              analyzing
                ? "styleGuide.analysis.analyzing"
                : "styleGuide.analysis.run",
            )}
          </Button>
        </div>
      </div>
    </section>
  );
}

export function StyleGuideTabs({
  active,
  onChange,
}: {
  active: StyleGuideTab;
  onChange: (tab: StyleGuideTab) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const tabs: Array<{ id: StyleGuideTab; label: string }> = [
    { id: "glossary", label: t("styleGuide.tabs.glossary") },
    { id: "characters", label: t("styleGuide.tabs.characters") },
    { id: "rules", label: t("styleGuide.tabs.rules") },
    { id: "memory", label: t("styleGuide.tabs.memory") },
  ];
  return (
    <Tabs
      className="style-guide-tabs"
      ariaLabel={t("styleGuide.tabs.ariaLabel")}
      items={tabs.map((item) => ({
        value: item.id,
        label: item.label,
        id: `style-guide-tab-${item.id}`,
        panelId: `style-guide-panel-${item.id}`,
      }))}
      value={active}
      onChange={onChange}
    />
  );
}
