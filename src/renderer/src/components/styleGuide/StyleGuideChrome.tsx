import React from "react";
import { useTranslation } from "react-i18next";
import type {
  ChapterStoryMemory,
  WorkStyleGuide,
} from "../../../../shared/workContextTypes";
import type { WorkContextAnalysisScope } from "../../../../shared/workContextAnalysisTypes";
import type { WorkContextBudgetPlan } from "../../../../shared/workContextBudget";
import type { WorkContextUsage } from "../../../../shared/workContextUsageTypes";
import type { WorkContextUsageStatus } from "./useStyleGuideModalModel";
import { Button } from "../ui/Button";
import { Tabs } from "../ui/Tabs";
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
  analyzingScope,
  disabled,
  onAnalyze,
}: {
  analyzingScope: WorkContextAnalysisScope | null;
  disabled: boolean;
  onAnalyze: (scope: WorkContextAnalysisScope) => void;
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
      <div className="style-guide-analysis-actions">
        <span className="style-guide-analysis-scope">
          {t("styleGuide.analysis.scope")}
        </span>
        <AnalysisButton
          scope="chapter"
          analyzingScope={analyzingScope}
          disabled={disabled}
          onAnalyze={onAnalyze}
        />
        <AnalysisButton
          scope="work"
          analyzingScope={analyzingScope}
          disabled={disabled}
          onAnalyze={onAnalyze}
        />
      </div>
    </section>
  );
}

function AnalysisButton({
  scope,
  analyzingScope,
  disabled,
  onAnalyze,
}: {
  scope: WorkContextAnalysisScope;
  analyzingScope: WorkContextAnalysisScope | null;
  disabled: boolean;
  onAnalyze: (scope: WorkContextAnalysisScope) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <Button
      variant={scope === "work" ? "primary" : undefined}
      disabled={disabled}
      aria-busy={analyzingScope === scope}
      onClick={() => onAnalyze(scope)}
    >
      {t(
        analyzingScope === scope
          ? "styleGuide.analysis.analyzing"
          : scope === "work"
            ? "styleGuide.analysis.entireWork"
            : "styleGuide.analysis.currentChapter",
      )}
    </Button>
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
