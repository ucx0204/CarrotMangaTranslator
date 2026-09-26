import type { JobEvent } from "../../shared/jobTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import {
  PAGE_WORKFLOW_STAGE_LABELS,
  type PageWorkflowStage,
} from "../../shared/pageWorkflowStages";

// Nested single-page pipelines report their own 1/1 counters. Only the outer
// workflow owns the aggregate counters and terminal job lifecycle.
export function createPageWorkflowProgress(
  id: string,
  total: number,
  emit: (event: JobEvent) => void,
) {
  let current = -1;
  let label = "";
  const report = (event: JobEvent) =>
    emit({
      ...event,
      id,
      kind: "gemma-analysis",
      status: "running",
      progressText: label
        ? `${label} · ${event.progressText}`
        : event.progressText,
      progressCurrent: Math.max(0, current),
      progressTotal: total,
      progressMode: undefined,
      progressPercent: undefined,
      pageIndex: undefined,
      pageTotal: undefined,
    });
  return {
    emit: report,
    begin: (stage: PageWorkflowStage, page: MangaPage) => {
      current += 1;
      label = `${PAGE_WORKFLOW_STAGE_LABELS[stage]} · ${page.name}`;
      emit({
        id,
        kind: "gemma-analysis",
        status: "running",
        phase: "model_requesting",
        progressText: label,
        progressCurrent: current,
        progressTotal: total,
      });
    },
  };
}
