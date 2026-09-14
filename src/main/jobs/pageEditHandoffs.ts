import { randomUUID } from "node:crypto";
import type {
  PageEditHandoffResponse,
  PageProcessingActivity,
} from "../../shared/appActivityTypes";
import { logError } from "../logger";

type PendingHandoff = {
  response: (response: PageEditHandoffResponse) => void;
  retry: () => void;
};

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
      this.set({ jobId, chapterId, pageId, phase: "queued" });
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
    pending.response(response);
    return true;
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
        await this.waitForRetry(page, result.error, signal);
      } finally {
        this.pending.delete(requestId);
      }
    }
  }

  private attempt(
    page: Omit<PageProcessingActivity, "phase"> & { requestId: string },
    signal: AbortSignal,
  ): Promise<PageEditHandoffResponse> {
    return new Promise((resolve, reject) => {
      const finish = (response: PageEditHandoffResponse) => {
        cleanup();
        resolve(response);
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      const timer = setTimeout(
        () =>
          finish({
            requestId: page.requestId,
            error:
              "편집 저장 응답을 기다리고 있습니다. 저장 상태를 확인하고 다시 시도해 주세요.",
          }),
        15000,
      );
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
      this.set({ ...page, phase: "finishing-edits" });
      if (signal.aborted) abort();
    });
  }

  private waitForRetry(
    page: Omit<PageProcessingActivity, "phase"> & { requestId: string },
    reason: string,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const retry = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      this.pending.set(page.requestId, { response: () => undefined, retry });
      signal.addEventListener("abort", abort, { once: true });
      this.set({ ...page, phase: "waiting", reason });
      if (signal.aborted) abort();
    });
  }
}
