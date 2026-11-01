import {
  readChangedField,
  resultListSummary,
  actionTypeLabel,
} from "./conditionalBatchResultPresentation";
import { useTranslation } from "react-i18next";
import { appI18n } from "../appI18n";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import React from "react";

import {
  type ConditionalBatchPreview,
  type ConditionalBatchPreviewResult,
} from "../../../shared/conditionalBatchRules";
import { stripRichTextMarkup } from "../../../shared/richTextMarkup";
import styles from "./ConditionalBatchEditor.module.css";
import { formatConditionalBatchDisplayValue } from "./conditionalBatchPresentation";

import { CONDITIONAL_BATCH_FIELD_LABELS } from "./conditionalBatchLabels";
import { Button, Button as UiButton } from "./ui/Button";
import { CheckboxField } from "./ui/CheckboxField";

const t = appI18n.getFixedT(null, "components");

export type ConditionalBatchResultsCardProps = {
  currentResult: ConditionalBatchPreviewResult | null;
  currentResultIndex: number;
  excludedResultKeys: ReadonlySet<string>;
  preview: ConditionalBatchPreview;
  onMoveResult: (offset: number) => void;
  onSelectResult: (result: ConditionalBatchPreviewResult) => void;
  onSetAllResultsIncluded: (included: boolean) => void;
  onToggleResult: (key: string, included: boolean) => void;
};

export function ConditionalBatchResultsCard(
  props: ConditionalBatchResultsCardProps,
): React.JSX.Element {
  useTranslation();
  const includedCount = props.preview.results.reduce(
    (count, result) =>
      count + (props.excludedResultKeys.has(result.key) ? 0 : 1),
    0,
  );
  return (
    <section
      className={styles.resultsPanel}
      aria-label={t("batchEditorCopy.results")}
    >
      <header className={styles.resultsToolbar}>
        <strong>
          {props.preview.inspectionOnly
            ? t("batchEditorMessages.matches", {
                p0: props.preview.matchedCount,
              })
            : t("batchEditorMessages.applyTo", {
                p0: includedCount,
                p1: props.preview.results.length,
              })}
        </strong>
        <div>
          <Button
            size="sm"
            variant="ghost"
            disabled={
              props.preview.results.length === 0 ||
              includedCount === props.preview.results.length
            }
            onClick={() => props.onSetAllResultsIncluded(true)}
          >
            {t("batchEditorCopy.includeAll")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={props.preview.results.length === 0 || includedCount === 0}
            onClick={() => props.onSetAllResultsIncluded(false)}
          >
            {t("batchEditorCopy.excludeAll")}
          </Button>
        </div>
      </header>
      <ResultScopeSummary preview={props.preview} />
      <div className={styles.resultsPanelBody}>
        <ResultList {...props} />
        {props.currentResult ? (
          <CurrentResultCard {...props} result={props.currentResult} />
        ) : (
          <div className={styles.emptyResults}>
            {emptyResultMessage(props.preview)}
          </div>
        )}
      </div>
    </section>
  );
}

function ResultScopeSummary({
  preview,
}: {
  preview: ConditionalBatchPreview;
}): React.JSX.Element {
  useTranslation();
  if (preview.inspectionOnly) {
    return (
      <div className={styles.resultScopeSummary} role="status">
        {t("batchEditorMessages.inspectionSummary", {
          count: preview.matchedCount,
        })}
      </div>
    );
  }
  return (
    <div className={styles.resultScopeSummary} role="status">
      <span>
        {t("batchEditorMessages.changeSummary", {
          matched: preview.matchedCount,
          changed: preview.results.length,
          unchanged: preview.unchangedMatchCount,
        })}
      </span>
    </div>
  );
}

function emptyResultMessage(preview: ConditionalBatchPreview): string {
  if (preview.inspectionOnly || preview.matchedCount === 0) {
    return t("blockLibrary.noSearchResults");
  }
  return t("batchEditorMessages.itemsMatchedButNoValuesWouldChange", {
    p0: preview.matchedCount,
  });
}

function CurrentResultCard({
  currentResultIndex,
  excludedResultKeys,
  onMoveResult,
  onToggleResult,
  preview,
  result,
}: ConditionalBatchResultsCardProps & {
  result: ConditionalBatchPreviewResult;
}) {
  useTranslation();
  const included = !excludedResultKeys.has(result.key);
  return (
    <div className={styles.currentResultCard}>
      <div className={styles.currentResultHeader}>
        <div>
          <strong>{result.pageName}</strong>
          <span>
            {currentResultIndex + 1} / {preview.results.length}
          </span>
        </div>
        <div className={styles.currentResultNav}>
          <Button
            size="sm"
            aria-label={t("conditionalBatch.results.previous")}
            iconLeft={<IconChevronLeft size={15} />}
            onClick={() => onMoveResult(-1)}
          />
          <Button
            size="sm"
            aria-label={t("conditionalBatch.results.next")}
            iconLeft={<IconChevronRight size={15} />}
            onClick={() => onMoveResult(1)}
          />
        </div>
      </div>
      {preview.inspectionOnly ? (
        <InspectionValues result={result} />
      ) : (
        <ChangedFieldDiffs result={result} />
      )}
      <CheckboxField
        checked={included}
        label={t("batchEditorCopy.includeInThisRun")}
        onCheckedChange={(next) => onToggleResult(result.key, next)}
      />
      {result.sequenceTrace?.length ? (
        <SequenceTraceDetails result={result} />
      ) : null}
      <JudgementDetails result={result} />
    </div>
  );
}

function SequenceTraceDetails({
  result,
}: {
  result: ConditionalBatchPreviewResult;
}) {
  useTranslation();
  return (
    <details className={styles.judgementDetails}>
      <summary>{t("batchEditorCopy.intermediateResultsByRule")}</summary>
      <ol className={styles.sequenceResultTrace}>
        {result.sequenceTrace?.map((trace) => (
          <li key={trace.stepId}>
            <span>
              <strong>{trace.schemeName}</strong>
              <small>
                {trace.changedFields.length
                  ? trace.changedFields
                      .map((field) => CONDITIONAL_BATCH_FIELD_LABELS[field])
                      .join(", ")
                  : t("batchEditorCopy.checkResults")}
              </small>
            </span>
            {trace.changedFields.includes("translatedText") ? (
              <DiffText
                before={stripRichTextMarkup(trace.beforeBlock.translatedText)}
                after={stripRichTextMarkup(trace.afterBlock.translatedText)}
              />
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

function ResultList(
  props: ConditionalBatchResultsCardProps,
): React.JSX.Element | null {
  useTranslation();
  const visibleResults = props.preview.results.slice(0, MAX_VISIBLE_RESULTS);
  if (visibleResults.length === 0) return null;
  return (
    <div
      className={styles.resultList}
      role="list"
      aria-label={t("batchEditorCopy.resultList")}
    >
      {visibleResults.map((result, index) => {
        const included = !props.excludedResultKeys.has(result.key);
        return (
          <div
            key={result.key}
            className={styles.resultRow}
            data-active={result.key === props.currentResult?.key}
            data-included={included}
            role="listitem"
          >
            <CheckboxField
              checked={included}
              ariaLabel={t("batchEditorMessages.includeResult", {
                p0: index + 1,
              })}
              onCheckedChange={(checked) =>
                props.onToggleResult(result.key, checked)
              }
            />
            <UiButton
              type="button"
              onClick={() => props.onSelectResult(result)}
              variant="bare"
            >
              <span>
                {index + 1}. {result.pageName}
              </span>
              <small>{resultListSummary(result, props.preview)}</small>
            </UiButton>
          </div>
        );
      })}
      {props.preview.results.length > MAX_VISIBLE_RESULTS ? (
        <div className={styles.resultLimit}>
          {t("batchEditorMessages.resultLimit", {
            shown: MAX_VISIBLE_RESULTS,
            total: props.preview.results.length,
          })}
        </div>
      ) : null}
    </div>
  );
}

function ChangedFieldDiffs({
  result,
}: {
  result: ConditionalBatchPreviewResult;
}): React.JSX.Element {
  useTranslation();
  return (
    <div className={styles.fieldDiffs}>
      {result.changedFields.map((field) => (
        <div className={styles.fieldDiff} key={field}>
          <strong>{CONDITIONAL_BATCH_FIELD_LABELS[field]}</strong>
          <DiffText
            before={readChangedField(
              result.beforeBlock,
              field,
              result.resolvedFieldValues?.[field]?.before,
            )}
            after={readChangedField(
              result.afterBlock,
              field,
              result.resolvedFieldValues?.[field]?.after,
            )}
          />
        </div>
      ))}
    </div>
  );
}

function InspectionValues({
  result,
}: {
  result: ConditionalBatchPreviewResult;
}) {
  useTranslation();
  return (
    <div className={styles.inspectionValues}>
      <div>
        <span>{t("conditionalBatch.when.sourceText")}</span>
        <p>{result.beforeBlock.sourceText || "∅"}</p>
      </div>
      <div>
        <span>{t("conditionalBatch.when.translatedText")}</span>
        <p>{stripRichTextMarkup(result.beforeBlock.translatedText) || "∅"}</p>
      </div>
    </div>
  );
}

function JudgementDetails({
  result,
}: {
  result: ConditionalBatchPreviewResult;
}) {
  useTranslation();
  return (
    <details className={styles.judgementDetails}>
      <summary>{t("batchEditorCopy.evaluationDetails")}</summary>
      <div>
        {result.conditionEvaluations.map((evaluation) => (
          <span key={evaluation.conditionId} data-matched={evaluation.matched}>
            {evaluation.matched
              ? t("mcp.pass")
              : t("batchEditorCopy.doesNotMatch")}{" "}
            · {CONDITIONAL_BATCH_FIELD_LABELS[evaluation.field]} ={" "}
            {formatConditionalBatchDisplayValue(
              evaluation.field,
              evaluation.rawValue,
            )}
          </span>
        ))}
        {result.actionTrace.map((trace) => (
          <span key={`${trace.stepId ?? "rule"}:${trace.actionId}`}>
            {trace.schemeName ? `${trace.schemeName} · ` : ""}
            {actionTypeLabel(trace.actionType)}
            {trace.changedFields.length
              ? ` · ${trace.changedFields
                  .map((field) => CONDITIONAL_BATCH_FIELD_LABELS[field])
                  .join(", ")}`
              : t("batchEditorCopy.unchanged")}
          </span>
        ))}
      </div>
    </details>
  );
}

function DiffText({ before, after }: { before: string; after: string }) {
  useTranslation();
  return (
    <div className={styles.diffText}>
      <div>
        <span>{t("conditionalBatch.preview.before")}</span>
        <p>{before || "∅"}</p>
      </div>
      <div>
        <span>{t("conditionalBatch.preview.after")}</span>
        <p>{after || "∅"}</p>
      </div>
    </div>
  );
}

const MAX_VISIBLE_RESULTS = 100;
