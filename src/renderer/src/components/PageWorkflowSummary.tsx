import { useTranslation } from "react-i18next";
import { appI18n } from "../appI18n";
import React from "react";
import type { TranslationOptionsModalProps } from "./translationOptionsModalTypes";
import type { usePageWorkflowModalState } from "./pageWorkflowModalState";
import { CONDITIONAL_BATCH_FIELD_LABELS } from "./conditionalBatchLabels";
import { Button } from "./ui/Button";
import { CheckboxField } from "./ui/CheckboxField";
import styles from "./PageWorkflowModal.module.css";

const t = appI18n.getFixedT(null, "components");

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
  useTranslation();
  const [details, setDetails] = React.useState(false);
  return (
    <section className={styles.summary} aria-live="polite">
      <div className={styles.summaryHeading}>
        <strong>{workflowScopeLabel(state)}</strong>
        <span>
          {state.plan.overwrite.length
            ? t("batchEditorCopy.overwriteSelectedExistingValues")
            : t("batchEditorCopy.preserveExistingResultsProcessEmptyItemsOnly")}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setDetails(!details)}
          aria-expanded={details}
        >
          {details
            ? t("batchEditorCopy.hideDetails")
            : t("batchEditorCopy.processingDetails")}
        </Button>
      </div>
      {details && <WorkflowCounts state={state} />}
      {requiresFontOcr(state.plan) && (
        <p>{t("batchEditorCopy.ocrRequiredForFontAnalysis")}</p>
      )}
      {state.preflight?.ruleEffects?.map((effect, index) => (
        <p key={index}>
          {t(`pageList.timing.workflow.stages.${effect.stage}`)} · {effect.name}
          :{" "}
          {effect.fields
            .map(
              (field) =>
                CONDITIONAL_BATCH_FIELD_LABELS[
                  field as keyof typeof CONDITIONAL_BATCH_FIELD_LABELS
                ] ?? field,
            )
            .join(", ")}{" "}
          {t("settings.api.vertexServiceAccountChange")}
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
          label={t("batchEditorMessages.confirmChangesToExistingValues", {
            p0: state.plan.overwrite
              .map((id) =>
                appI18n.t(`pageList.timing.workflow.stages.${id}`, {
                  ns: "components",
                }),
              )
              .join(", "),
          })}
        />
      )}
    </section>
  );
}

/** "80페이지 × 7단계 = 단계 작업 560개", matching the progress counter. */
function workflowScopeLabel(state: Props["state"]): string {
  const stages = state.plan.stages.length;
  if (!state.preflight) return t("batchEditorMessages.steps", { p0: stages });
  const pages = state.preflight.pageCount;
  return t("batchEditorMessages.pagesStepsStepTasks", {
    p0: pages,
    p1: stages,
    p2: pages * stages,
  });
}

function requiresFontOcr(plan: Props["state"]["plan"]) {
  return (
    plan.stages.includes("typography") &&
    plan.autoFont &&
    !plan.stages.includes("ocr")
  );
}

function WorkflowCounts({ state }: Pick<Props, "state">) {
  useTranslation();
  return (
    <table className={styles.counts}>
      <thead>
        <tr>
          <th>{t("batchEditorCopy.workflowOrder")}</th>
          <th>{t("batchEditorCopy.process")}</th>
          <th>{t("batchEditorCopy.preserve")}</th>
          <th>{t("batchEditorCopy.noTargets")}</th>
        </tr>
      </thead>
      <tbody>
        {state.preflight?.counts.map((count) => (
          <tr key={count.stage}>
            <th>{t(`pageList.timing.workflow.stages.${count.stage}`)}</th>
            <td>{count.process}</td>
            <td>{count.preserve}</td>
            <td>{count.empty}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
