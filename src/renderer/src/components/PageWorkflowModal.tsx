import { useTranslation } from "react-i18next";
import { PageWorkflowSummary } from "./PageWorkflowSummary";
import { PageWorkflowStages } from "./PageWorkflowStages";
import { PageWorkflowOptions } from "./PageWorkflowOptions";
import React from "react";
import type {
  TranslationOptionsModalProps,
  TranslationModalPresentation,
} from "./translationOptionsModalTypes";
import { usePageWorkflowModalState } from "./pageWorkflowModalState";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { CheckboxField } from "./ui/CheckboxField";
import { BinaryChapterPagePicker } from "./BinaryChapterPagePicker";
import { ChapterPickerHeader } from "./ChapterPickerHeader";
import { handoffActiveModalToWorkCenter } from "../lib/modalWorkCenterHandoff";
import styles from "./PageWorkflowModal.module.css";
import { resolveOcrEngineDisplayName } from "../../../shared/ocrEngines";

export function PageWorkflowModal(
  props: TranslationOptionsModalProps & TranslationModalPresentation,
) {
  const { t } = useTranslation("components");
  const state = usePageWorkflowModalState(props);
  const [confirmed, setConfirmed] = React.useState(false);
  const [saveDefault, setSaveDefault] = React.useState(false);
  const starting = React.useRef(false);
  const changePlan: typeof state.setPlan = (next) => {
    state.setPlan(next);
    state.setResume(null);
    setConfirmed(false);
  };
  const startIssue = state.request
    ? (props.pageWorkflowStartIssue?.(state.request) ?? null)
    : null;
  const start = () => {
    if (
      !state.request ||
      starting.current ||
      startIssue ||
      !props.onStartPageWorkflow
    )
      return;
    starting.current = true;
    if (saveDefault)
      props.onPersistDefaults({ pageWorkflowDefault: state.plan });
    handoffActiveModalToWorkCenter();
    void props.onStartPageWorkflow(state.request);
    props.onClose();
  };
  return (
    <Modal
      title={t("runPanel.pageActions")}
      headerExtra={
        props.headerExtra ?? (
          <span className={styles.engine}>
            {resolveOcrEngineDisplayName(
              props.settings?.ocr.pipeline ?? "hayai",
            )}
          </span>
        )
      }
      resizeFromWidth={props.resizeFromWidth}
      width="min(1440px, 100%)"
      bodyLayout="bare"
      fillHeight
      onClose={props.onClose}
      bodyClassName={styles.body}
      footer={
        <WorkflowFooter
          state={state}
          startIssue={startIssue}
          canStart={Boolean(props.onStartPageWorkflow)}
          confirmed={confirmed}
          saveDefault={saveDefault}
          setSaveDefault={setSaveDefault}
          onCancel={props.onClose}
          onStart={start}
        />
      }
    >
      <PageWorkflowOptions
        props={props}
        state={state}
        changePlan={changePlan}
      />
      <div className={styles.columns}>
        <WorkflowSelection props={props} state={state} />
        <WorkflowTasks state={state} changePlan={changePlan} />
      </div>
      <PageWorkflowSummary
        props={props}
        state={state}
        confirmed={confirmed}
        setConfirmed={setConfirmed}
      />
    </Modal>
  );
}

function WorkflowFooter({
  state,
  startIssue,
  canStart,
  confirmed,
  saveDefault,
  setSaveDefault,
  onCancel,
  onStart,
}: {
  state: ReturnType<typeof usePageWorkflowModalState>;
  startIssue: string | null;
  canStart: boolean;
  confirmed: boolean;
  saveDefault: boolean;
  setSaveDefault: (value: boolean) => void;
  onCancel: () => void;
  onStart: () => void;
}) {
  const { t } = useTranslation("components");
  const blocked =
    !canStart ||
    !state.request ||
    !state.preflight ||
    Boolean(startIssue) ||
    !!state.error ||
    state.preflight.issues.length > 0 ||
    (state.plan.overwrite.length > 0 && !confirmed);
  return (
    <div className={styles.footer}>
      <CheckboxField
        checked={saveDefault}
        onCheckedChange={setSaveDefault}
        label={t("batchEditorCopy.saveAsDefaultConfiguration")}
      />
      {startIssue ? (
        <span className={styles.startIssue} role="status">
          {startIssue}
        </span>
      ) : null}
      <Button variant="ghost" onClick={onCancel}>
        {t("common.cancel")}
      </Button>
      <Button variant="primary" onClick={onStart} disabled={blocked}>
        {state.resume
          ? t("pageList.timing.workflow.resumed")
          : t("batchEditorCopy.startWorkflow")}
      </Button>
    </div>
  );
}

type ViewProps = {
  props: TranslationOptionsModalProps;
  state: ReturnType<typeof usePageWorkflowModalState>;
};
function WorkflowSelection({ props, state }: ViewProps) {
  const { t } = useTranslation("components");
  const [expanded, setExpanded] = React.useState(false);
  const work = state.work;
  return (
    <section className={styles.selection} data-expanded={expanded}>
      <div className={styles.sectionHeading}>
        <h3>{t("batchEditorCopy.targetPages")}</h3>
        <span>
          {state.preflight
            ? t("common.pageCount", { count: state.preflight.pageCount })
            : "—"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className={styles.selectionToggle}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded
            ? t("batchEditorCopy.collapse")
            : t("settings.api.vertexServiceAccountChange")}
        </Button>
      </div>
      <div className={`${styles.selectionContent} page-picker-fill-modal`}>
        {work && (
          <BinaryChapterPagePicker
            key={state.selectionResetKey}
            work={work}
            currentChapter={props.chapter}
            currentPageId={props.currentPageId}
            selection={state.selection}
            onChange={(next) => {
              state.setResume(null);
              state.setSelection(next);
            }}
            renderHeader={(actions) => (
              <ChapterPickerHeader
                pageWork
                workTitle={work.title}
                onSelectAll={actions.selectAll}
                onClear={actions.clear}
              />
            )}
            getChapterSummary={(chapter, pages) =>
              t("common.pageCount", {
                count: pages?.length ?? chapter.pageCount,
              })
            }
            renderSelectionSummary={() => null}
          />
        )}
      </div>
    </section>
  );
}

function WorkflowTasks({
  state,
  changePlan,
}: {
  state: ReturnType<typeof usePageWorkflowModalState>;
  changePlan: ReturnType<typeof usePageWorkflowModalState>["setPlan"];
}) {
  const { t } = useTranslation("components");
  return (
    <section
      className={styles.tasks}
      aria-label={t("batchEditorCopy.executionOrder")}
    >
      <div className={styles.sectionHeading}>
        <h3>{t("batchEditorCopy.executionOrder")}</h3>
        <span>
          {t("batchEditorMessages.selectedCount", {
            count: state.plan.stages.length,
          })}
        </span>
      </div>
      <PageWorkflowStages
        plan={state.plan}
        onChange={changePlan}
        rules={state.rules}
      />
    </section>
  );
}
