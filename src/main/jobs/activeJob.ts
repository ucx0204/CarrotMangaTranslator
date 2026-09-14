import type { JobEvent } from "../../shared/jobTypes";
import type { AppActivityResource } from "../../shared/appActivityTypes";
import {
  AppActivityGate,
  isAppActivityUnavailableError,
  type AppActivityLease,
} from "../appActivityGate";
import { logError, logInfo } from "../logger";
import { withLibraryActivityOwner } from "../library/lock";
import type { AppSettings } from "../../shared/settingsTypes";
import { withExecutionSettings } from "../settings/executionSettings";
import { PageEditHandoffs } from "./pageEditHandoffs";

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
  resources?: readonly AppActivityResource[];
};

export class ActiveJobStore {
  readonly pageHandoffs = new PageEditHandoffs();
  private readonly entries = new Map<
    string,
    { job: ActiveJob; lease: AppActivityLease }
  >();
  private readonly cleanupPromises = new WeakMap<ActiveJob, Promise<void>>();

  constructor(
    private readonly diagnostics: JobCleanupDiagnostics = productionDiagnostics,
    private readonly activityGate: AppActivityGate = new AppActivityGate(),
  ) {}

  get current(): ActiveJob | null {
    return (
      this.all.find((job) => job.kind !== "page-export") ?? this.all[0] ?? null
    );
  }

  get all(): ActiveJob[] {
    return [...this.entries.values()].map(({ job }) => job);
  }

  get(id: string): ActiveJob | null {
    return this.entries.get(id)?.job ?? null;
  }

  get gate(): AppActivityGate {
    return this.activityGate;
  }

  run<T>(id: string, run: () => T, settings?: AppSettings): T {
    return withLibraryActivityOwner(id, () =>
      withExecutionSettings(settings, run),
    );
  }

  updateResources(id: string, resources: readonly AppActivityResource[]): void {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Job is no longer active.");
    entry.lease.updateResources(resources);
    entry.job.resources = structuredClone(resources);
  }

  get hasActive(): boolean {
    return this.activityGate.isUnavailable;
  }

  start(job: ActiveJob): void {
    if (this.entries.has(job.id)) throw new Error("Job id is already active.");

    let lease: AppActivityLease;
    try {
      lease = this.activityGate.acquire({
        id: job.id,
        category: "job",
        kind: job.kind,
        mutatesLibrary: job.kind !== "page-export",
        blocksQuit: true,
        resources: job.resources,
      });
    } catch (error) {
      if (isAppActivityUnavailableError(error)) {
        throw new Error(
          `이미 실행 중인 작업이 있습니다. ${error instanceof Error ? error.message : ""}`,
          { cause: error },
        );
      }
      throw error;
    }

    this.entries.set(job.id, { job, lease });
  }

  updateLastEvent(jobId: string, event: JobEvent): void {
    const entry = this.entries.get(jobId);
    if (entry) entry.job.lastEvent = event;
  }

  clearIfCurrent(jobId: string): void {
    const entry = this.entries.get(jobId);
    if (!entry) return;
    this.entries.delete(jobId);
    this.pageHandoffs.removeJob(jobId);
    entry.lease.release();
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
