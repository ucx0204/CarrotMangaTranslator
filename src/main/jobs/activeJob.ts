import type { JobEvent } from "../../shared/types";
import { logError, logInfo } from "../logger";

export type ActiveJob = {
  id: string;
  kind: JobEvent["kind"];
  abortController: AbortController;
  cleanup?: () => Promise<void>;
  lastEvent?: JobEvent;
};

export class ActiveJobStore {
  private activeJob: ActiveJob | null = null;

  get current(): ActiveJob | null {
    return this.activeJob;
  }

  get hasActive(): boolean {
    return Boolean(this.activeJob);
  }

  start(job: ActiveJob): void {
    if (this.activeJob) {
      throw new Error("이미 실행 중인 작업이 있습니다.");
    }
    this.activeJob = job;
  }

  updateLastEvent(jobId: string, event: JobEvent): void {
    if (this.activeJob?.id === jobId) {
      this.activeJob.lastEvent = event;
    }
  }

  setCleanup(jobId: string, cleanup: () => Promise<void>): void {
    if (this.activeJob?.id === jobId) {
      this.activeJob.cleanup = cleanup;
    }
  }

  clearIfCurrent(jobId: string): void {
    if (this.activeJob?.id === jobId) {
      this.activeJob = null;
    }
  }

  async runCleanup(job: ActiveJob, reason: string): Promise<void> {
    const cleanup = job.cleanup;
    if (!cleanup) {
      return;
    }
    job.cleanup = undefined;
    try {
      await cleanup();
      logInfo("Analysis runtime cleanup completed", { jobId: job.id, reason });
    } catch (error) {
      logError("Analysis runtime cleanup failed", { jobId: job.id, reason, error });
    }
  }
}
