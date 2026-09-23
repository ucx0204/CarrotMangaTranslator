import { Button } from "./ui/Button";
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import React from "react";
import { type PageWorkflowPlan } from "../../../shared/pageWorkflowTypes";
import {
  PAGE_WORKFLOW_STAGES,
  PAGE_WORKFLOW_STAGE_LABELS,
  type PageWorkflowStage,
} from "../../../shared/pageWorkflowStages";
import type { ConditionalBatchSnapshotV2 } from "../../../shared/conditionalBatchRules";
import { CheckboxField } from "./ui/CheckboxField";
import { FloatingControlTooltip } from "./ui/FloatingControlTooltip";
import { Select } from "./ui/Select";
import styles from "./PageWorkflowModal.module.css";

type Props = {
  plan: PageWorkflowPlan;
  onChange: (plan: PageWorkflowPlan) => void;
  rules: ConditionalBatchSnapshotV2;
};

const STAGE_DESCRIPTIONS: Record<PageWorkflowStage, string> = {
  detect: "원본 이미지에서 텍스트 블록과 읽기 순서를 찾습니다.",
  ocr: "기존 블록의 빈 원문을 OCR로 채웁니다.",
  "source-rules": "선택한 규칙으로 번역 전 원문을 교정합니다.",
  translate: "저장된 원문으로 빈 번역문을 채웁니다.",
  "translation-rules": "선택한 규칙으로 번역문을 정리합니다.",
  typography: "번역문의 폰트와 글자 크기를 원문에 맞춥니다.",
  "format-rules": "자동 서식 이후 글꼴·크기·강조 규칙을 적용합니다.",
  erase: "블록 영역의 원문을 지웁니다.",
  layout: "번역문을 말풍선에 맞춰 배치하고 줄바꿈을 조정합니다.",
  review: "빈 번역, 숫자, 괄호, 공백, 용어집 불일치를 검사합니다.",
};

const OPTION_DESCRIPTIONS = {
  autoFont: "원문과 어울리는 글꼴을 자동 선택합니다.",
  autoSize: "번역문의 글자 크기를 원문 글자 크기에 맞춥니다.",
  bubbleLayout: "번역문을 말풍선 안에 맞춰 배치합니다.",
  naturalLayout: "번역문을 읽기 자연스러운 단위로 줄바꿈합니다.",
  cumulative: "앞 페이지의 번역 문맥을 다음 페이지에 이어서 사용합니다.",
};

export function PageWorkflowStages(props: Props) {
  const [expanded, setExpanded] = React.useState<PageWorkflowStage | null>(
    null,
  );
  return (
    <div className={styles.stages}>
      {PAGE_WORKFLOW_STAGES.map((stage, index) => (
        <WorkflowStageRow
          key={stage}
          {...props}
          stage={stage}
          index={index}
          expanded={expanded === stage}
          onExpand={() => setExpanded(expanded === stage ? null : stage)}
        />
      ))}
    </div>
  );
}

function WorkflowStageRow(
  props: Props & {
    stage: PageWorkflowStage;
    index: number;
    expanded: boolean;
    onExpand: () => void;
  },
) {
  const { stage, plan, onChange } = props;
  const enabled = plan.stages.includes(stage);
  const label = PAGE_WORKFLOW_STAGE_LABELS[stage];
  const open = enabled && props.expanded;
  const detailsId = React.useId();
  return (
    <section className={styles.stage} data-enabled={enabled}>
      <div className={styles.stageRow}>
        <span className={styles.stageNumber} aria-hidden="true">
          {props.index + 1}
        </span>
        <FloatingControlTooltip
          className={styles.stageControl}
          content={STAGE_DESCRIPTIONS[stage]}
        >
          {(descriptionId) => (
            <CheckboxField
              className={styles.stageCheck}
              ariaDescribedBy={descriptionId}
              checked={enabled}
              ariaLabel={`${props.index + 1}. ${label}`}
              label={label}
              onCheckedChange={(checked) =>
                onChange({
                  ...plan,
                  overwrite: checked
                    ? plan.overwrite
                    : plan.overwrite.filter((id) => id !== stage),
                  stages: PAGE_WORKFLOW_STAGES.filter((id) =>
                    id === stage ? checked : plan.stages.includes(id),
                  ),
                })
              }
            />
          )}
        </FloatingControlTooltip>
        {enabled && stage !== "review" && (
          <Button
            variant="ghost"
            size="sm"
            className={styles.stageSettings}
            aria-label={`${label} 설정`}
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={props.onExpand}
            iconRight={
              open ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />
            }
          >
            {workflowStageSummary(stage, plan)}
          </Button>
        )}
        {stage === "review" && enabled && (
          <span className={styles.stageHint}>문제만 표시</span>
        )}
      </div>
      {open && (
        <div className={styles.details} id={detailsId}>
          <WorkflowStageDetails {...props} />
        </div>
      )}
    </section>
  );
}

function WorkflowStageDetails(props: Props & { stage: PageWorkflowStage }) {
  const { stage, plan, onChange } = props;
  if (
    stage === "source-rules" ||
    stage === "translation-rules" ||
    stage === "format-rules"
  )
    return <RuleSelector {...props} stage={stage} />;
  return (
    <>
      <div className={styles.inlineOptions}>
        <StageOptions {...props} />
      </div>
      <FloatingControlTooltip
        content={
          stage === "detect"
            ? "기존 블록과 원문·번역·수동 서식을 새 검출 결과로 교체합니다."
            : "완료된 항목과 수동 설정에도 다시 적용합니다."
        }
      >
        {(descriptionId) => (
          <CheckboxField
            ariaDescribedBy={descriptionId}
            checked={plan.overwrite.includes(stage)}
            label={
              stage === "detect"
                ? "기존 블록 교체 (원문·번역·수동 서식 삭제)"
                : "기존 값에도 다시 적용"
            }
            onCheckedChange={(checked) =>
              onChange({
                ...plan,
                overwrite: checked
                  ? [...plan.overwrite, stage]
                  : plan.overwrite.filter((id) => id !== stage),
              })
            }
          />
        )}
      </FloatingControlTooltip>
    </>
  );
}

function workflowStageSummary(
  stage: PageWorkflowStage,
  plan: PageWorkflowPlan,
): string {
  if (
    stage === "source-rules" ||
    stage === "translation-rules" ||
    stage === "format-rules"
  )
    return plan.rules[stage] ? "규칙 선택됨" : "규칙 선택";
  if (plan.overwrite.includes(stage)) return "덮어쓰기";
  if (stage === "translate") return plan.cumulative ? "누적 번역" : "일반 번역";
  if (stage === "typography")
    return summarizeOptions([
      [plan.autoFont, "폰트"],
      [plan.autoSize, "크기"],
    ]);
  if (stage === "erase")
    return { codex: "Codex", local: "로컬 엔진" }[plan.erasureEngine];
  if (stage === "layout")
    return summarizeOptions([
      [plan.bubbleLayout, "말풍선"],
      [plan.naturalLayout, "줄바꿈"],
    ]);
  return stage === "detect" ? "기존 블록 보존" : "빈 원문만";
}

function summarizeOptions(options: Array<[boolean, string]>) {
  return (
    options
      .filter(([enabled]) => enabled)
      .map(([, label]) => label)
      .join(" · ") || "설정 필요"
  );
}

function RuleSelector({
  plan,
  rules,
  onChange,
  stage,
}: Props & { stage: keyof PageWorkflowPlan["rules"] }) {
  const value = plan.rules[stage];
  return (
    <Select
      ariaLabel={`${PAGE_WORKFLOW_STAGE_LABELS[stage]} 규칙`}
      value={value ? `${value.kind}:${value.id}` : ""}
      placeholder="규칙 또는 규칙 묶음 선택"
      options={[
        ...rules.schemes.map((s) => ({
          value: `scheme:${s.id}`,
          label: s.name,
        })),
        ...rules.sequences.map((s) => ({
          value: `sequence:${s.id}`,
          label: `${s.name} · 묶음`,
        })),
      ]}
      onValueChange={(next) => {
        const [kind, id] = next.split(":");
        onChange({ ...plan, rules: { ...plan.rules, [stage]: { kind, id } } });
      }}
    />
  );
}

function StageOptions({
  plan,
  onChange,
  stage,
}: Props & { stage: PageWorkflowStage }) {
  const toggle = (
    key:
      | "autoFont"
      | "autoSize"
      | "bubbleLayout"
      | "naturalLayout"
      | "cumulative",
    label: string,
  ) => (
    <FloatingControlTooltip key={key} content={OPTION_DESCRIPTIONS[key]}>
      {(descriptionId) => (
        <CheckboxField
          ariaDescribedBy={descriptionId}
          checked={plan[key]}
          label={label}
          onCheckedChange={(value) => onChange({ ...plan, [key]: value })}
        />
      )}
    </FloatingControlTooltip>
  );
  if (stage === "typography")
    return (
      <>
        {toggle("autoFont", "폰트 맞춤")}
        {toggle("autoSize", "원문에 글자 크기 맞춤")}
      </>
    );
  if (stage === "layout")
    return (
      <>
        {toggle("bubbleLayout", "말풍선 맞춤")}
        {toggle("naturalLayout", "자연스러운 줄바꿈")}
      </>
    );
  if (stage === "erase")
    return <ErasureStageOptions plan={plan} onChange={onChange} />;
  if (stage !== "translate") return null;
  return (
    <>
      {toggle("cumulative", "누적 번역")}
      {plan.cumulative && (
        <CumulativeStageOptions plan={plan} onChange={onChange} />
      )}
    </>
  );
}

function ErasureStageOptions({
  plan,
  onChange,
}: Pick<Props, "plan" | "onChange">) {
  return (
    <FloatingControlTooltip content="원문 제거에 사용할 엔진을 선택합니다.">
      {(descriptionId) => (
        <Select
          ariaDescribedBy={descriptionId}
          ariaLabel="원문 제거 엔진"
          value={plan.erasureEngine}
          options={[
            { value: "local", label: "설정된 로컬 제거 엔진" },
            { value: "codex", label: "Codex" },
          ]}
          onValueChange={(value) =>
            onChange({ ...plan, erasureEngine: value as "local" | "codex" })
          }
        />
      )}
    </FloatingControlTooltip>
  );
}

function CumulativeStageOptions({
  plan,
  onChange,
}: Pick<Props, "plan" | "onChange">) {
  return (
    <FloatingControlTooltip content="다음 페이지로 넘길 번역 기억의 양을 정합니다.">
      {(descriptionId) => (
        <Select
          ariaDescribedBy={descriptionId}
          ariaLabel="누적 기억 상세도"
          value={plan.cumulativeDetail}
          options={[
            { value: "detailed", label: "상세" },
            { value: "balanced", label: "균형" },
            { value: "essential", label: "핵심" },
          ]}
          onValueChange={(value) =>
            onChange({
              ...plan,
              cumulativeDetail: value as PageWorkflowPlan["cumulativeDetail"],
            })
          }
        />
      )}
    </FloatingControlTooltip>
  );
}
