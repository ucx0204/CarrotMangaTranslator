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
import { ChapterPagePicker } from "./ChapterPagePicker";
import { handoffActiveModalToWorkCenter } from "../lib/modalWorkCenterHandoff";
import styles from "./PageWorkflowModal.module.css";

export function PageWorkflowModal(
  props: TranslationOptionsModalProps & TranslationModalPresentation,
) {
  const state = usePageWorkflowModalState(props);
  const [confirmed, setConfirmed] = React.useState(false);
  const [saveDefault, setSaveDefault] = React.useState(false);
  const starting = React.useRef(false);
  const changePlan: typeof state.setPlan = (next) => {
    state.setPlan(next);
    state.setResume(null);
    setConfirmed(false);
  };
  const start = () => {
    if (!state.request || starting.current || !props.onStartPageWorkflow)
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
      title="페이지 작업"
      headerExtra={
        props.headerExtra ?? <span className={styles.engine}>HayaiOCR</span>
      }
      resizeFromWidth={props.resizeFromWidth}
      width="min(1440px, 100%)"
      bodyLayout="bare"
      fillHeight
      onClose={props.onClose}
      bodyClassName={styles.body}
      footer={
        <div className={styles.footer}>
          <CheckboxField
            checked={saveDefault}
            onCheckedChange={setSaveDefault}
            label="기본 구성으로 저장"
          />
          <Button onClick={props.onClose}>취소</Button>
          <Button
            variant="primary"
            onClick={start}
            disabled={
              !props.onStartPageWorkflow ||
              !state.request ||
              !state.preflight ||
              !!state.error ||
              state.preflight.issues.length > 0 ||
              (state.plan.overwrite.length > 0 && !confirmed)
            }
          >
            {state.resume ? "이어서 실행" : "작업 시작"}
          </Button>
        </div>
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

type ViewProps = {
  props: TranslationOptionsModalProps;
  state: ReturnType<typeof usePageWorkflowModalState>;
};
function WorkflowSelection({ props, state }: ViewProps) {
  const [expanded, setExpanded] = React.useState(false);
  return (
    <section className={styles.selection} data-expanded={expanded}>
      <div className={styles.sectionHeading}>
        <h3>대상 페이지</h3>
        <span>{state.preflight?.pageCount ?? "—"}페이지</span>
        <Button
          variant="ghost"
          size="sm"
          className={styles.selectionToggle}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "접기" : "변경"}
        </Button>
      </div>
      <div className={`${styles.selectionContent} page-picker-fill-modal`}>
        {state.work && (
          <ChapterPagePicker
            pageWork
            work={state.work}
            currentChapter={props.chapter}
            currentPageId={props.currentPageId}
            selection={state.selection}
            onChange={(next) => {
              state.setResume(null);
              state.setSelection(next);
            }}
            resumeContext={{
              blockMode: "keep",
              sourceLanguage: props.sourceLanguage ?? "ja",
              targetLanguage: props.targetLanguage ?? "ko",
            }}
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
  return (
    <section className={styles.tasks} aria-label="실행 순서">
      <div className={styles.sectionHeading}>
        <h3>실행 순서</h3>
        <span>{state.plan.stages.length}개 선택</span>
      </div>
      <PageWorkflowStages
        plan={state.plan}
        onChange={changePlan}
        rules={state.rules}
      />
    </section>
  );
}
