import {
  STAGE_DESCRIPTIONS,
  OPTION_DESCRIPTIONS,
} from "./pageWorkflowDescriptions";
import { useTranslation } from "react-i18next";
import { appI18n } from "../appI18n";
import { Button } from "./ui/Button";
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import React from "react";
import { type PageWorkflowPlan } from "../../../shared/pageWorkflowTypes";
import {
  PAGE_WORKFLOW_STAGES,
  type PageWorkflowStage,
} from "../../../shared/pageWorkflowStages";
import type { ConditionalBatchSnapshotV2 } from "../../../shared/conditionalBatchRules";
import { CheckboxField } from "./ui/CheckboxField";
import { FloatingControlTooltip } from "./ui/FloatingControlTooltip";
import { Select } from "./ui/Select";
import styles from "./PageWorkflowModal.module.css";

const t = appI18n.getFixedT(null, "components");

type Props = {
  plan: PageWorkflowPlan;
  onChange: (plan: PageWorkflowPlan) => void;
  rules: ConditionalBatchSnapshotV2;
};

export function PageWorkflowStages(props: Props) {
  useTranslation();
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
  useTranslation();
  const { stage, plan, onChange } = props;
  const enabled = plan.stages.includes(stage);
  const label = t(`pageList.timing.workflow.stages.${stage}`);
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
            aria-label={t("batchEditorMessages.settings", {
              p0: label,
            })}
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
          <span className={styles.stageHint}>
            {t("batchEditorCopy.showIssuesOnly")}
          </span>
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
  useTranslation();
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
            ? t(
                "batchEditorCopy.replaceExistingBlocksSourceTextTranslationsAndManualFormatting",
              )
            : t("batchEditorCopy.reapplyToCompletedItemsAndManualSettingsToo")
        }
      >
        {(descriptionId) => (
          <CheckboxField
            ariaDescribedBy={descriptionId}
            checked={plan.overwrite.includes(stage)}
            label={
              stage === "detect"
                ? t(
                    "batchEditorCopy.replaceExistingBlocksDeletesSourceTranslationAndManualFormatting",
                  )
                : t("batchEditorCopy.reapplyToExistingValues")
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
    return plan.rules[stage]
      ? t("batchEditorCopy.ruleSelected")
      : t("batchEditorCopy.selectRule");
  if (plan.overwrite.includes(stage)) return t("batchEditorCopy.overwrite");
  if (stage === "translate")
    return plan.cumulative
      ? t("batchEditorCopy.cumulativeTranslation")
      : t("translationOptions.workspaceAction");
  if (stage === "typography")
    return summarizeOptions([
      [plan.autoFont, t("fontSelect.label")],
      [plan.autoSize, t("format.size")],
    ]);
  if (stage === "erase")
    return {
      codex: "Codex",
      local: t("batchEditorCopy.localEngine"),
    }[plan.erasureEngine];
  if (stage === "layout")
    return summarizeOptions([
      [plan.bubbleLayout, t("pageList.timing.stages.bubbleLayout")],
      [plan.naturalLayout, t("formatBatch.groups.wordBreak")],
    ]);
  return stage === "detect"
    ? t("batchEditorCopy.preserveExistingBlocks")
    : t("batchEditorCopy.emptySourceTextOnly");
}

function summarizeOptions(options: Array<[boolean, string]>) {
  return (
    options
      .filter(([enabled]) => enabled)
      .map(([, label]) => label)
      .join(" · ") || t("batchEditorCopy.configurationRequired")
  );
}

function RuleSelector({
  plan,
  rules,
  onChange,
  stage,
}: Props & { stage: keyof PageWorkflowPlan["rules"] }) {
  useTranslation();
  const value = plan.rules[stage];
  return (
    <Select
      ariaLabel={t("batchEditorMessages.rules", {
        p0: appI18n.t(`pageList.timing.workflow.stages.${stage}`, {
          ns: "components",
        }),
      })}
      value={value ? `${value.kind}:${value.id}` : ""}
      placeholder={t("batchEditorCopy.selectARuleOrRuleSequence")}
      options={[
        ...rules.schemes.map((s) => ({
          value: `scheme:${s.id}`,
          label: s.name,
        })),
        ...rules.sequences.map((s) => ({
          value: `sequence:${s.id}`,
          label: t("batchEditorMessages.sequence", {
            p0: s.name,
          }),
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
  useTranslation();
  const toggle = (
    key:
      "autoFont" | "autoSize" | "bubbleLayout" | "naturalLayout" | "cumulative",
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
        {toggle("autoFont", t("batchEditorCopy.matchFont"))}
        {toggle("autoSize", t("batchEditorCopy.matchSourceTextSize"))}
      </>
    );
  if (stage === "layout")
    return (
      <>
        {toggle("bubbleLayout", t("editor.fitBubble"))}
        {toggle("naturalLayout", t("batchEditorCopy.naturalLineBreaks"))}
      </>
    );
  if (stage === "erase")
    return <ErasureStageOptions plan={plan} onChange={onChange} />;
  if (stage !== "translate") return null;
  return (
    <>
      {toggle("cumulative", t("batchEditorCopy.cumulativeTranslation"))}
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
  useTranslation();
  return (
    <FloatingControlTooltip
      content={t("batchEditorCopy.chooseTheEngineUsedToEraseSourceText")}
    >
      {(descriptionId) => (
        <Select
          ariaDescribedBy={descriptionId}
          ariaLabel={t("batchEditorCopy.sourceErasureEngine")}
          value={plan.erasureEngine}
          options={[
            {
              value: "local",
              label: t("batchEditorCopy.configuredLocalErasureEngine"),
            },
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
  useTranslation();
  return (
    <FloatingControlTooltip
      content={t("batchEditorCopy.setHowMuchTranslationMemoryToCarryToThe")}
    >
      {(descriptionId) => (
        <Select
          ariaDescribedBy={descriptionId}
          ariaLabel={t("batchEditorCopy.cumulativeMemoryDetail")}
          value={plan.cumulativeDetail}
          options={[
            {
              value: "detailed",
              label: t("batchEditorCopy.detailed"),
            },
            {
              value: "balanced",
              label: t("batchEditorCopy.balanced"),
            },
            {
              value: "essential",
              label: t("batchEditorCopy.essential"),
            },
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
