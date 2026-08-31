import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import React from "react";
import { formatConditionalBatchFieldValue } from "../../../shared/conditionalBatchFieldRegistry";
import { readConditionalBatchWritableValue } from "../../../shared/conditionalBatchEngine";
import {
  type ConditionalBatchPreview,
  type ConditionalBatchPreviewResult,
  type ConditionalBatchWritableField,
} from "../../../shared/conditionalBatchRules";
import { stripRichTextMarkup } from "../../../shared/richTextMarkup";
import { CONDITIONAL_BATCH_FIELD_LABELS } from "./conditionalBatchUi";
import { Button, CheckboxField } from "./ConditionalBatchControls";
import styles from "./ConditionalBatchEditor.module.css";

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
  const includedCount = props.preview.results.reduce(
    (count, result) =>
      count + (props.excludedResultKeys.has(result.key) ? 0 : 1),
    0,
  );
  return (
    <section className={styles.resultsPanel} aria-label="결과">
      <header className={styles.resultsToolbar}>
        <strong>결과 {props.preview.results.length}</strong>
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
            전체 포함
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={props.preview.results.length === 0 || includedCount === 0}
            onClick={() => props.onSetAllResultsIncluded(false)}
          >
            전체 제외
          </Button>
        </div>
      </header>
      <div className={styles.resultsPanelBody}>
        <ResultList {...props} />
        {props.currentResult ? (
          <CurrentResultCard {...props} result={props.currentResult} />
        ) : (
          <div className={styles.emptyResults}>
            조건에 맞는 결과가 없습니다.
          </div>
        )}
      </div>
    </section>
  );
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
            aria-label="이전 변경 후보"
            iconLeft={<IconChevronLeft size={15} />}
            onClick={() => onMoveResult(-1)}
          />
          <Button
            size="sm"
            aria-label="다음 변경 후보"
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
        label="이번 실행에 포함"
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
  return (
    <details className={styles.judgementDetails}>
      <summary>규칙별 중간 결과</summary>
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
                  : "검사 결과"}
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
  const visibleResults = props.preview.results.slice(0, MAX_VISIBLE_RESULTS);
  if (visibleResults.length === 0) return null;
  return (
    <div className={styles.resultList} role="list" aria-label="결과 목록">
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
              ariaLabel={`${index + 1}번 결과 포함`}
              onCheckedChange={(checked) =>
                props.onToggleResult(result.key, checked)
              }
            />
            <button type="button" onClick={() => props.onSelectResult(result)}>
              <span>
                {index + 1}. {result.pageName}
              </span>
              <small>{resultListSummary(result, props.preview)}</small>
            </button>
          </div>
        );
      })}
      {props.preview.results.length > MAX_VISIBLE_RESULTS ? (
        <div className={styles.resultLimit}>
          앞의 {MAX_VISIBLE_RESULTS}개만 표시 중 · 전체{" "}
          {props.preview.results.length}개
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
  return (
    <div className={styles.fieldDiffs}>
      {result.changedFields.map((field) => (
        <div className={styles.fieldDiff} key={field}>
          <strong>{CONDITIONAL_BATCH_FIELD_LABELS[field]}</strong>
          <DiffText
            before={readChangedField(result.beforeBlock, field)}
            after={readChangedField(result.afterBlock, field)}
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
  return (
    <div className={styles.inspectionValues}>
      <div>
        <span>원문</span>
        <p>{result.beforeBlock.sourceText || "∅"}</p>
      </div>
      <div>
        <span>번역문</span>
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
  return (
    <details className={styles.judgementDetails}>
      <summary>판정 내역</summary>
      <div>
        {result.conditionEvaluations.map((evaluation) => (
          <span key={evaluation.conditionId} data-matched={evaluation.matched}>
            {evaluation.matched ? "통과" : "불일치"} ·{" "}
            {CONDITIONAL_BATCH_FIELD_LABELS[evaluation.field]} ={" "}
            {evaluation.actualValue}
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
              : " · 변경 없음"}
          </span>
        ))}
      </div>
    </details>
  );
}

function DiffText({ before, after }: { before: string; after: string }) {
  return (
    <div className={styles.diffText}>
      <div>
        <span>전</span>
        <p>{before || "∅"}</p>
      </div>
      <div>
        <span>후</span>
        <p>{after || "∅"}</p>
      </div>
    </div>
  );
}

function readChangedField(
  block: ConditionalBatchPreviewResult["beforeBlock"],
  field: ConditionalBatchWritableField,
): string {
  const value = readConditionalBatchWritableValue(block, field);
  if (field === "translatedText") {
    return stripRichTextMarkup(String(value ?? ""));
  }
  if (value === undefined || value === "") return "∅";
  if (typeof value === "boolean") return value ? "예" : "아니오";
  if (typeof value === "number") return formatConditionalBatchFieldValue(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function resultListSummary(
  result: ConditionalBatchPreviewResult,
  preview: ConditionalBatchPreview,
): string {
  if (preview.inspectionOnly) {
    return stripRichTextMarkup(result.beforeBlock.translatedText) || "빈 번역";
  }
  const fields = result.changedFields
    .map((field) => CONDITIONAL_BATCH_FIELD_LABELS[field])
    .join(", ");
  const first = result.changedFields[0];
  return first
    ? `${fields} · ${readChangedField(result.beforeBlock, first)}`
    : fields;
}

function actionTypeLabel(
  type: ConditionalBatchPreviewResult["actionTrace"][number]["actionType"],
): string {
  if (type === "replaceText") return "찾아 바꾸기";
  if (type === "setFields") return "속성 바꾸기";
  if (type === "applyStylePreset") return "스타일 프리셋";
  return "부분 서식";
}

const MAX_VISIBLE_RESULTS = 100;
