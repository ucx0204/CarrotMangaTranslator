import React from "react";
import { useTranslation } from "react-i18next";
import type {
  WorkContextResearchOperation,
  WorkContextResearchProposal,
} from "../../../../shared/workContextResearchTypes";
import { appGateway } from "../../api/appGateway";
import buttonStyles from "../ui/Button.module.css";
import checkboxStyles from "../ui/CheckboxField.module.css";

export function StyleGuideResearchReview({
  proposal,
  selectedIds,
  onSelectedIdsChange,
}: {
  proposal: WorkContextResearchProposal;
  selectedIds: ReadonlySet<string>;
  onSelectedIdsChange: (ids: Set<string>) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const toggle = (id: string): void => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedIdsChange(next);
  };
  const operationIds = proposal.operations.map((operation) => operation.id);
  const allSelected =
    operationIds.length > 0 &&
    operationIds.every((operationId) => selectedIds.has(operationId));
  return (
    <>
      <div className="style-guide-research-review-toolbar">
        <div className="style-guide-research-summary">
          {t("styleGuide.research.reviewSummary", {
            count: proposal.operations.length,
            queries: proposal.stats.queryCount,
            credits: proposal.stats.tavilyCreditsUsed,
            seconds: (proposal.stats.elapsedMs / 1_000).toFixed(1),
          })}
        </div>
        <div className="style-guide-research-selection-actions">
          <button
            type="button"
            className={`${buttonStyles.button} ${buttonStyles.secondary} ${buttonStyles.sm}`}
            disabled={operationIds.length === 0 || allSelected}
            onClick={() => onSelectedIdsChange(new Set(operationIds))}
          >
            <span className={buttonStyles.label}>{t("common.selectAll")}</span>
          </button>
          <button
            type="button"
            className={`${buttonStyles.button} ${buttonStyles.secondary} ${buttonStyles.sm}`}
            disabled={selectedIds.size === 0}
            onClick={() => onSelectedIdsChange(new Set())}
          >
            <span className={buttonStyles.label}>{t("common.clearAll")}</span>
          </button>
        </div>
      </div>
      {proposal.warnings.length ? (
        <div className="style-guide-research-warnings">
          {proposal.warnings.map((warning) => (
            <p key={warning} className="style-guide-research-warning">
              {warning}
            </p>
          ))}
        </div>
      ) : null}
      <div className="style-guide-research-operation-list">
        {proposal.operations.length ? (
          proposal.operations.map((operation) => (
            <ResearchOperationRow
              key={operation.id}
              operation={operation}
              selected={selectedIds.has(operation.id)}
              onToggle={() => toggle(operation.id)}
            />
          ))
        ) : (
          <p className="muted-line">{t("styleGuide.research.noChanges")}</p>
        )}
      </div>
    </>
  );
}

function ResearchOperationRow({
  operation,
  selected,
  onToggle,
}: {
  operation: WorkContextResearchOperation;
  selected: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <article className="style-guide-research-operation">
      <input
        type="checkbox"
        className={checkboxStyles.input}
        checked={selected}
        aria-label={t("styleGuide.research.selectChange", {
          name: operationName(operation),
        })}
        onChange={onToggle}
      />
      <div className="style-guide-research-operation-body">
        <div className="style-guide-research-operation-title">
          <strong>{operationName(operation)}</strong>
          <span data-action={operation.action}>
            {t(`styleGuide.research.actions.${operation.action}`)}
          </span>
          <span data-confidence={operation.confidence}>
            {t(`styleGuide.research.confidence.${operation.confidence}`)}
          </span>
        </div>
        <p>{formatChange(operation)}</p>
        <p>{operation.reason}</p>
        <small>
          {t("styleGuide.research.localEvidence", {
            pages: operation.evidence.pageCount,
            mentions: operation.evidence.mentionCount,
          })}
          {operation.evidence.sample ? ` · ${operation.evidence.sample}` : ""}
        </small>
        {operation.sources.length ? (
          <div className="style-guide-research-sources">
            {operation.sources.map((source) => (
              <button
                key={source.url}
                type="button"
                title={source.url}
                onClick={() => {
                  void appGateway
                    .openResearchSource(source.url)
                    .catch((error) => console.error(error));
                }}
              >
                {source.title}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function operationName(operation: WorkContextResearchOperation): string {
  return operation.entity === "glossary"
    ? operation.after.source
    : operation.after.displayName;
}

function formatChange(operation: WorkContextResearchOperation): string {
  if (operation.action === "disable") return "enabled: true → false";
  if (operation.entity === "glossary") {
    const after = `${operation.after.source} → ${operation.after.target || "—"}`;
    return operation.before
      ? `${operation.before.source} → ${operation.before.target || "—"}  /  ${after}`
      : after;
  }
  const after = `${operation.after.sourceNames.join(", ")} → ${operation.after.targetName || "—"}`;
  return operation.before
    ? `${operation.before.sourceNames.join(", ")} → ${operation.before.targetName || "—"}  /  ${after}`
    : after;
}
