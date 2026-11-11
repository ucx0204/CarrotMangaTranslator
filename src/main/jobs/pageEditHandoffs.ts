import { randomUUID } from "node:crypto";
import type {
  PageEditHandoffResponse,
  PageProcessingActivity,
} from "../../shared/appActivityTypes";
import { logError, logInfo, logWarn } from "../logger";

type PendingHandoff = {
  response: (response: PageEditHandoffResponse) => boolean;
  retry: () => void;
};

type HandoffAttempt = PageEditHandoffResponse & { timedOut?: boolean };

/** The renderer acknowledges only after pointer/IME completion and durable page saves. */
export class PageEditHandoffs {
  private readonly pages = new Map<string, PageProcessingActivity>();
  private readonly pending = new Map<string, PendingHandoff>();
  private readonly listeners = new Set<() => void>();

  get activities(): PageProcessingActivity[] {
    return Array.from(this.pages.values(), (page) => ({ ...page }));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reserve(jobId: string, chapterId: string, pageIds: readonly string[]): void {
    for (const pageId of pageIds)
      this.pages.set(`${jobId}/${chapterId}/${pageId}`, {
        jobId,
        chapterId,
        pageId,
        phase: "queued",
      });
    // Reservations are synchronous; no observer needs the partial list.
    // Publishing it per page creates quadratic IPC traffic on large batches.
    if (pageIds.length) this.emit();
  }

  set(page: PageProcessingActivity): void {
    this.pages.set(`${page.jobId}/${page.chapterId}/${page.pageId}`, page);
    this.emit();
  }

  removeJob(jobId: string): void {
    for (const [key, page] of this.pages)
      if (page.jobId === jobId) this.pages.delete(key);
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        logError("Page handoff observer failed", error);
      }
    }
  }

  respond(response: PageEditHandoffResponse): boolean {
    const pending = this.pending.get(response.requestId);
    if (!pending) return false;
    return pending.response(response);
  }

  retry(requestId: string): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    pending.retry();
    return true;
  }

  async request(
    jobId: string,
    chapterId: string,
    pageId: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    while (true) {
      const requestId = randomUUID();
      const page = { jobId, chapterId, pageId, requestId };
      try {
        const result = await this.attempt(page, signal);
        signal.throwIfAborted();
        if (!result.error) return;
        await this.waitForRetry(
          page,
          result.error,
          signal,
          result.timedOut === true,
        );
      } finally {
        this.pending.delete(requestId);
      }
    }
  }

  private attempt(
    page: Omit<PageProcessingActivity, "phase"> & { requestId: string },
    signal: AbortSignal,
  ): Promise<HandoffAttempt> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      let settled = false;
      const finish = (response: HandoffAttempt) => {
        if (settled) return false;
        settled = true;
        cleanup();
        logInfo("Page edit handoff result", {
          ...page,
          elapsedMs: Date.now() - startedAt,
          timedOut: response.timedOut === true,
          error: response.error,
        });
        resolve(response);
        return true;
      };
      const abort = () => {
        settled = true;
        cleanup();
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        logWarn("Page edit handoff timed out", page);
        finish({
          requestId: page.requestId,
          timedOut: true,
          error:
            "편집 저장 응답을 기다리고 있습니다. 저장 상태를 확인하고 다시 시도해 주세요.",
        });
      }, 15000);
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      this.pending.set(page.requestId, {
        response: finish,
        retry: () =>
          finish({
            requestId: page.requestId,
            error: "인계를 다시 요청합니다.",
          }),
      });
      signal.addEventListener("abort", abort, { once: true });
      logInfo("Page edit handoff requested", page);
      this.set({ ...page, phase: "finishing-edits" });
      if (signal.aborted) abort();
    });
  }

  private waitForRetry(
    page: Omit<PageProcessingActivity, "phase"> & { requestId: string },
    reason: string,
    signal: AbortSignal,
    retryOnLateCompletion: boolean,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let retried = false;
      const retry = () => {
        if (retried) return;
        retried = true;
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        retried = true;
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      this.pending.set(page.requestId, {
        response: (response) => {
          if (!retryOnLateCompletion || retried) return false;
          retryOnLateCompletion = false;
          if (response.error) {
            logWarn("Page edit handoff late save failed", {
              ...page,
              error: response.error,
            });
            this.set({ ...page, phase: "waiting", reason: response.error });
            return true;
          }
          // Input may have resumed while the warning was shown. Obtain a new
          // acknowledgement instead of granting ownership from the late one.
          logInfo("Page edit handoff retrying after late save", page);
          retry();
          return true;
        },
        retry,
      });
      signal.addEventListener("abort", abort, { once: true });
      this.set({ ...page, phase: "waiting", reason });
      if (signal.aborted) abort();
    });
  }
}
