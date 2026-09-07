import type { JobEvent } from "../../shared/jobTypes";
import type {
  CodexProgressUpdate,
  CodexTypesettingProgress,
} from "../../shared/codexTypesettingProgress";

export function createCodexProgressReporter(
  jobId: string,
  total: number,
  emit: (event: JobEvent) => void,
) {
  let current: CodexTypesettingProgress = {
    stage: "reading",
    step: "reading",
    completed: 0,
    total,
  };
  return (update: CodexProgressUpdate): void => {
    const { pageCommitted, ...progress } = update;
    const stageChanged =
      update.stage !== undefined && update.stage !== current.stage;
    current = {
      ...current,
      page: stageChanged ? undefined : current.page,
      completed: stageChanged ? 0 : current.completed,
      part: undefined,
      parts: undefined,
      attempt: update.step === current.step ? current.attempt : undefined,
      delaySeconds: undefined,
      ...progress,
    };
    emit({
      id: jobId,
      kind: "gemma-analysis",
      status: "running",
      phase: pageCommitted ? "page_done" : "model_requesting",
      progressText: `Astra · ${current.stage} · ${current.step}`,
      codexProgress: { ...current },
      pageIndex: current.page,
      pageTotal: total,
      progressCurrent: current.completed,
      progressTotal: total,
      progressMode: current.stage === "fonts" ? "indeterminate" : undefined,
    });
  };
}
