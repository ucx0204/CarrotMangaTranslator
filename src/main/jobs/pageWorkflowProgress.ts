import type { PageWorkflowResult } from "../../shared/pageWorkflowTypes";
import type { JobEvent } from "../../shared/jobTypes";
import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import {
  PAGE_WORKFLOW_STAGE_LABELS,
  type PageWorkflowStage,
} from "../../shared/pageWorkflowStages";

const INNER_CHECKPOINT_PHASES = new Set([
  "page_done",
  "page_skipped",
  "inpainting_done",
]);

// Nested single-page pipelines report their own 1/1 counters. Only the outer
// workflow owns the aggregate counters and terminal job lifecycle.
export function createPageWorkflowProgress(
  id: string,
  scope: { pageCount: number; stageCount: number },
  emit: (event: JobEvent) => void,
) {
  let current = 0;
  let stageLabel = "";
  let pageName = "";
  let chapterId: string | undefined;
  const total = scope.pageCount * scope.stageCount;
  const report = (event: JobEvent) =>
    emit({
      ...event,
      id,
      kind: "gemma-analysis",
      status: "running",
      phase: INNER_CHECKPOINT_PHASES.has(event.phase ?? "")
        ? "page_running"
        : event.phase,
      progressText: [
        stageLabel,
        pageName && !event.progressText.includes(pageName) ? pageName : "",
        event.progressText,
      ]
        .filter(Boolean)
        .join(" · "),
      workflowProgress: { ...scope, chapterId },
      progressCurrent: current,
      progressTotal: total,
      progressMode: undefined,
      progressPercent: undefined,
      pageIndex: undefined,
      pageTotal: undefined,
    });
  const select = (
    stage: PageWorkflowStage,
    chapter: ChapterSnapshot,
    page?: MangaPage,
  ) => {
    chapterId = chapter.id;
    stageLabel = `${chapter.title} · ${PAGE_WORKFLOW_STAGE_LABELS[stage]}`;
    pageName = page?.name ?? "";
  };
  const checkpoint = (phase: JobEvent["phase"]) =>
    emit({
      id,
      kind: "gemma-analysis",
      status: "running",
      phase,
      progressText: [stageLabel, pageName].filter(Boolean).join(" · "),
      workflowProgress: { ...scope, chapterId },
      progressCurrent: current,
      progressTotal: total,
    });
  return {
    emit: report,
    prepare: (stage: PageWorkflowStage, chapter: ChapterSnapshot) => {
      select(stage, chapter);
      checkpoint("model_requesting");
    },
    begin: (
      stage: PageWorkflowStage,
      page: MangaPage,
      chapter: ChapterSnapshot,
    ) => {
      select(stage, chapter, page);
      checkpoint("model_requesting");
    },
    settled: (
      stage: PageWorkflowStage,
      page: MangaPage,
      chapter: ChapterSnapshot,
    ) => {
      select(stage, chapter, page);
      current += 1;
      // Only the outer runner publishes this checkpoint, after durable save (or skip).
      checkpoint("page_done");
    },
  };
}

export function emitWorkflowCompletion(
  emit: (event: JobEvent) => void,
  id: string,
  result: PageWorkflowResult,
  total: number,
  lastEvent?: JobEvent,
) {
  emit({
    id,
    kind: "gemma-analysis",
    status: result.status,
    phase: result.status === "completed" ? "done" : result.status,
    progressText:
      result.issues[0]?.message ??
      (result.status === "cancelled"
        ? "페이지 작업 취소"
        : result.status === "completed"
          ? "페이지 작업 완료"
          : "페이지 작업 실패"),
    progressCurrent:
      result.status === "completed" ? total : lastEvent?.progressCurrent,
    progressTotal: total,
    pageIndex: lastEvent?.pageIndex,
    pageTotal: lastEvent?.pageTotal,
    detail: lastEvent?.detail,
  });
}
