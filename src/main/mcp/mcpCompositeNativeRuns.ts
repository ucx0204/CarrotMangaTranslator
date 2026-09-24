import { mcpWorkflowOutputs } from "../../shared/mcpWorkflow";
import { mcpResearchBatchOutputs } from "../../shared/mcpResearchBatch";
import { mcpImportBatchOutputs } from "../../shared/mcpImportBatch";
import type { McpCompositeWorkflowAction } from "../../shared/mcpCompositeWorkflowActions";
import type {
  McpCompositeGuard,
  McpCompositeRecord,
} from "../application/mcpCompositeWorkflowPorts";
import type { AppSettings } from "../../shared/settingsTypes";
import { McpEditError } from "../application/mcpEditPolicy";
import type { CompositeNativeRead } from "./mcpCompositeNativeTools";
import type { McpCompositeNativePage } from "./mcpCompositeNativePages";
import {
  nativeCompositeCost,
  selectCompositeNativePages,
  requireCompositeWholePages,
  scopeError,
} from "./mcpCompositeNativeScope";

type Workflow = Extract<McpCompositeWorkflowAction, { kind: "workflow-run" }>;
type Research = Extract<McpCompositeWorkflowAction, { kind: "research-run" }>;
type Imports = Extract<
  McpCompositeWorkflowAction,
  { kind: "import-batch-run" }
>;

export async function costCompositeWorkflowRun(
  read: CompositeNativeRead,
  record: McpCompositeRecord,
  action: Workflow,
  values: McpCompositeNativePage[],
  settings: AppSettings,
  guard: McpCompositeGuard,
) {
  const view = await read(
    mcpWorkflowOutputs.carrot_get_workflow,
    "carrot_get_workflow",
    { id: action.input.id },
    record.owner,
    guard,
  );
  if (
    view.id !== action.input.id ||
    view.version !== action.input.version ||
    view.status === "running"
  )
    throw scopeError();
  for (const chapterId of new Set(view.pages.map((page) => page.chapterId))) {
    const selected = selectCompositeNativePages(
      values,
      chapterId,
      view.pages.filter((page) => page.chapterId === chapterId),
    );
    if (
      view.stages.some((stage) =>
        ["ocr", "translate", "erase"].includes(stage.kind),
      )
    )
      requireCompositeWholePages(selected);
  }
  const translation = view.stages.find((stage) => stage.kind === "translate");
  if (translation && translation.expectedEngine !== settings.modelProvider)
    throw new McpEditError(
      "invalid_edit",
      "Workflow translation provider differs from the prepared app policy.",
    );
  const pending = view.steps.filter(
    (step) =>
      step.status !== "completed" &&
      (action.input.retryFailed || step.status !== "failed"),
  );
  const cost = nativeCompositeCost(
    Math.min(
      view.maxPageAttempts - view.pageAttemptsUsed,
      pending.filter((step) => step.stage !== "await-external").length,
    ),
  );
  cost.models.ocr = pending.filter((step) => step.stage === "ocr").length;
  cost.models.erase = pending.filter((step) => step.stage === "erase").length;
  if (pending.some((step) => step.stage === "translate")) {
    // OCR can discover blocks later in this same native child. Reserve its remaining native request ceiling.
    cost.translationRequests =
      view.maxTranslationRequests - view.translationRequestsReserved;
    cost.models.translation = cost.translationRequests;
  }
  return cost;
}
export async function costCompositeResearchRun(
  read: CompositeNativeRead,
  record: McpCompositeRecord,
  action: Research,
  values: McpCompositeNativePage[],
  guard: McpCompositeGuard,
) {
  const view = await read(
    mcpResearchBatchOutputs.carrot_get_research_batch,
    "carrot_get_research_batch",
    { id: action.input.id },
    record.owner,
    guard,
  );
  if (
    view.id !== action.input.id ||
    view.version !== action.input.version ||
    view.status === "running"
  )
    throw scopeError();
  for (const work of view.works)
    if (
      !values.some(
        ({ target }) =>
          target.workId === work.workId && target.chapterId === work.chapterId,
      )
    )
      throw scopeError();
  const pending = view.works.filter(
    (work) =>
      !["held", "proposed", "no_changes"].includes(work.status) &&
      (action.input.retryFailed || work.attempts.length === 0),
  );
  const cost = nativeCompositeCost();
  cost.researchAttempts = Math.min(
    pending.length,
    view.maxAttempts - view.attemptsUsed,
  );
  cost.models.research = cost.researchAttempts;
  return cost;
}
export async function costCompositeImportBatchRun(
  read: CompositeNativeRead,
  record: McpCompositeRecord,
  action: Imports,
  guard: McpCompositeGuard,
) {
  const view = await read(
    mcpImportBatchOutputs.carrot_get_import_batch,
    "carrot_get_import_batch",
    { id: action.input.id },
    record.owner,
    guard,
  );
  if (
    view.id !== action.input.id ||
    view.version !== action.input.version ||
    view.status === "running"
  )
    throw scopeError();
  const requested = [
    ...action.input.retryItemIds,
    ...action.input.rescanExpiredItemIds,
  ];
  if (requested.some((id) => !view.items.some((item) => item.id === id)))
    throw scopeError();
  return nativeCompositeCost();
}
