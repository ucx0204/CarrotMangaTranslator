import type { JobEvent } from "../../shared/jobTypes";
import { logError, logInfo } from "../logger";

export type JobCleanupDiagnostics = {
  error: (message: string, detail?: unknown) => void;
  info: (message: string, detail?: unknown) => void;
};

const productionDiagnostics: JobCleanupDiagnostics = {
  error: logError,
  info: logInfo,
};

export type ActiveJob = {
  id: string;
  kind: JobEvent["kind"];
  abortController: AbortController;
  cleanup?: () => Promise<void>;
  lastEvent?: JobEvent;
};

export class ActiveJobStore {
  private activeJob: ActiveJob | null = null;
  private readonly cleanupPromises = new WeakMap<ActiveJob, Promise<void>>();

  constructor(
    private readonly diagnostics: JobCleanupDiagnostics = productionDiagnostics,
  ) {}

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
    const inFlight = this.cleanupPromises.get(job);
    if (inFlight) {
      await inFlight;
      return;
    }
    const cleanup = job.cleanup;
    if (!cleanup) {
      return;
    }
    job.cleanup = undefined;
    let resolveCleanup: (() => void) | undefined;
    const cleanupPromise = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    this.cleanupPromises.set(job, cleanupPromise);
    try {
      await cleanup();
      this.diagnostics.info("Analysis runtime cleanup completed", {
        jobId: job.id,
        reason,
      });
    } catch (error) {
      this.diagnostics.error("Analysis runtime cleanup failed", {
        jobId: job.id,
        reason,
        error,
      });
    } finally {
      resolveCleanup?.();
      this.cleanupPromises.delete(job);
    }
  }
}
