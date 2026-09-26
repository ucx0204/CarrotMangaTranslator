import { hashStableValue } from "../../shared/blockFingerprint";
import { workflowStageKey } from "../../shared/pageWorkflowPolicy";
import { type PageWorkflowReceipt } from "../../shared/pageWorkflowReceipt";
import {
  PAGE_WORKFLOW_STAGES,
  type PageWorkflowStage,
} from "../../shared/pageWorkflowStages";
import type { MangaPage } from "../../shared/libraryTypes";
import type { PageWorkflowPlan } from "../../shared/pageWorkflowTypes";

export function workflowReceipt(
  input: { runId: string; plan: PageWorkflowPlan },
  page: MangaPage,
): PageWorkflowReceipt {
  const planKey = hashStableValue(input.plan);
  const previous = page.pageWorkflow;
  return previous?.runId === input.runId && previous.planKey === planKey
    ? structuredClone(previous)
    : {
        runId: input.runId,
        planKey,
        steps: {},
        findings: [],
        emptyDetectionKey: previous?.emptyDetectionKey,
      };
}

export function workflowStageComplete(
  receipt: PageWorkflowReceipt,
  page: MangaPage,
  stage: PageWorkflowStage,
  configurationKey?: string,
): boolean {
  if (
    stage === "translate" &&
    page.blocks.some(
      (block) => block.sourceText.trim() && !block.translatedText.trim(),
    )
  )
    return false;
  const step = receipt.steps[stage];
  return Boolean(
    step &&
    step.configurationKey === configurationKey &&
    step.status !== "failed" &&
    (step.resumeKey ?? step.outputKey) === workflowStageKey(page, stage),
  );
}

export function completeWorkflowReceipt(
  receipt: PageWorkflowReceipt,
  before: MangaPage,
  after: MangaPage,
  stage: PageWorkflowStage,
  configurationKey?: string,
): MangaPage {
  const steps = {
    ...receipt.steps,
    [stage]: {
      status:
        after.blocks.length === 0 ? ("empty" as const) : ("completed" as const),
      inputKey: workflowStageKey(before, stage),
      outputKey: workflowStageKey(after, stage),
      configurationKey,
    },
  };
  for (const id of PAGE_WORKFLOW_STAGES.slice(
    0,
    PAGE_WORKFLOW_STAGES.indexOf(stage) + 1,
  )) {
    const value = steps[id];
    if (value && value.status !== "failed")
      steps[id] = { ...value, resumeKey: workflowStageKey(after, id) };
  }
  return {
    ...after,
    pageWorkflow: {
      ...receipt,
      emptyDetectionKey:
        stage === "detect"
          ? after.blocks.length
            ? undefined
            : workflowStageKey(after, "detect")
          : receipt.emptyDetectionKey,
      steps,
      findings:
        stage === "review"
          ? (after.pageWorkflow?.findings ?? [])
          : receipt.findings,
    },
  };
}

export function failWorkflowReceipt(
  receipt: PageWorkflowReceipt,
  before: MangaPage,
  after: MangaPage,
  stage: PageWorkflowStage,
  message: string,
): MangaPage {
  return {
    ...after,
    ...(stage === "translate"
      ? { analysisStatus: "failed" as const, lastError: message }
      : {}),
    pageWorkflow: {
      ...receipt,
      steps: {
        ...receipt.steps,
        [stage]: {
          status: "failed",
          inputKey: workflowStageKey(before, stage),
          outputKey: workflowStageKey(after, stage),
          message,
        },
      },
    },
  };
}
