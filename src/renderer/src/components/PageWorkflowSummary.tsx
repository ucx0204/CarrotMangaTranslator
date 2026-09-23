import React from "react";
import type { TranslationOptionsModalProps } from "./translationOptionsModalTypes";
import type { usePageWorkflowModalState } from "./pageWorkflowModalState";
import { PAGE_WORKFLOW_STAGE_LABELS } from "../../../shared/pageWorkflowStages";
import { CONDITIONAL_BATCH_FIELD_LABELS } from "./conditionalBatchUi";
import { Button } from "./ui/Button";
import { CheckboxField } from "./ui/CheckboxField";
import styles from "./PageWorkflowModal.module.css";

type Props = {
  props: TranslationOptionsModalProps;
  state: ReturnType<typeof usePageWorkflowModalState>;
  confirmed: boolean;
  setConfirmed: (value: boolean) => void;
};
export function PageWorkflowSummary({
  props,
  state,
  confirmed,
  setConfirmed,
}: Props) {
  const [details, setDetails] = React.useState(false);
  return (
    <section className={styles.summary} aria-live="polite">
      <div className={styles.summaryHeading}>
        <strong>
          {state.preflight ? `${state.preflight.pageCount}페이지 · ` : ""}
          {state.plan.stages.length}개 작업
        </strong>
        <span>
          {state.plan.overwrite.length
            ? "선택한 기존 값 덮어쓰기"
            : "기존 결과 보존 · 빈 항목만 처리"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setDetails(!details)}
          aria-expanded={details}
        >
          {details ? "상세 접기" : "처리 내역"}
        </Button>
      </div>
      {details && <WorkflowCounts state={state} />}
      {requiresFontOcr(state.plan) && <p>폰트 분석용 OCR 필요</p>}
      {state.preflight?.ruleEffects?.map((effect, index) => (
        <p key={index}>
          {PAGE_WORKFLOW_STAGE_LABELS[effect.stage]} · {effect.name}:{" "}
          {effect.fields
            .map(
              (field) =>
                CONDITIONAL_BATCH_FIELD_LABELS[
                  field as keyof typeof CONDITIONAL_BATCH_FIELD_LABELS
                ] ?? field,
            )
            .join(", ")}{" "}
          변경
        </p>
      ))}
      {state.error && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}
      {state.preflight?.issues.map((issue, index) => (
        <p key={index} className={styles.error} role="alert">
          {props.chapter.pages.find((page) => page.id === issue.pageId)?.name ??
            issue.pageId}{" "}
          {issue.message}
        </p>
      ))}
      {state.plan.overwrite.length > 0 && (
        <CheckboxField
          checked={confirmed}
          onCheckedChange={setConfirmed}
          label={`기존 값 변경 확인: ${state.plan.overwrite.map((id) => PAGE_WORKFLOW_STAGE_LABELS[id]).join(", ")}`}
        />
      )}
    </section>
  );
}

function requiresFontOcr(plan: Props["state"]["plan"]) {
  return (
    plan.stages.includes("typography") &&
    plan.autoFont &&
    !plan.stages.includes("ocr")
  );
}

function WorkflowCounts({ state }: Pick<Props, "state">) {
  return (
    <table className={styles.counts}>
      <thead>
        <tr>
          <th>작업 순서</th>
          <th>처리</th>
          <th>보존</th>
          <th>대상 없음</th>
        </tr>
      </thead>
      <tbody>
        {state.preflight?.counts.map((count) => (
          <tr key={count.stage}>
            <th>{PAGE_WORKFLOW_STAGE_LABELS[count.stage]}</th>
            <td>{count.process}</td>
            <td>{count.preserve}</td>
            <td>{count.empty}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
