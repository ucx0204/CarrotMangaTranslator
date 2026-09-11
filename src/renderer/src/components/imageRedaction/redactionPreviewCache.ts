import type { RedactionPreviewRequest } from "../../../../shared/imageRedactionWorkspace";

type Task = {
  key: string;
  request: RedactionPreviewRequest;
  version: number;
  resolve: (url: string) => void;
  reject: (error: unknown) => void;
};
const MAX_BYTES = 24 * 1024 * 1024;
const MAX_ENTRIES = 72;

/** Bounded per-workspace cache and decoder queue; priority favors the active page. */
export class RedactionPreviewCache {
  private cache = new Map<string, string>();
  private pending = new Map<string, Promise<string>>();
  private queue: Task[] = [];
  private running = 0;
  private bytes = 0;
  private disposed = false;
  private versions = new Map<string, number>();
  private listeners = new Set<() => void>();
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  version(sessionId: string, pageId: string): number {
    return this.versions.get(`${sessionId}:${pageId}:`) ?? 0;
  }
  /** Retry every mounted variant; old requests cannot repopulate the new cache. */
  retryPage(sessionId: string, pageId: string): void {
    if (this.disposed) return;
    const prefix = `${sessionId}:${pageId}:`;
    this.versions.set(prefix, this.version(sessionId, pageId) + 1);
    for (const [key, url] of this.cache) {
      if (!key.startsWith(prefix)) continue;
      this.cache.delete(key);
      this.bytes -= url.length;
    }
    for (const listener of this.listeners) listener();
  }
  constructor(
    private readonly load: (
      request: RedactionPreviewRequest,
    ) => Promise<string>,
  ) {}
  read(request: RedactionPreviewRequest, priority = false): Promise<string> {
    if (this.disposed)
      return Promise.reject(new Error("Redaction preview queue is closed"));
    const version = this.version(request.sessionId, request.pageId);
    const key = `${request.sessionId}:${request.pageId}:${request.maxEdge}:${version}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return Promise.resolve(cached);
    }
    const pending = this.pending.get(key);
    if (pending) {
      if (priority) this.promote(key);
      return pending;
    }
    const operation = new Promise<string>((resolve, reject) => {
      const task = { key, request, version, resolve, reject };
      if (priority) this.queue.unshift(task);
      else this.queue.push(task);
    });
    this.pending.set(key, operation);
    this.pump();
    return operation;
  }
  dispose(): void {
    this.disposed = true;
    for (const task of this.queue.splice(0)) {
      this.pending.delete(task.key);
      task.reject(new Error("Redaction preview queue is closed"));
    }
    this.cache.clear();
    this.bytes = 0;
    this.listeners.clear();
    this.versions.clear();
  }
  private promote(key: string): void {
    const index = this.queue.findIndex((task) => task.key === key);
    if (index > 0) this.queue.unshift(...this.queue.splice(index, 1));
  }
  private pump(): void {
    while (!this.disposed && this.running < 3 && this.queue.length) {
      const task = this.queue.shift();
      if (!task) break;
      this.running++;
      void this.perform(task);
    }
  }
  private async perform(task: Task): Promise<void> {
    try {
      const url = await this.load(task.request);
      if (this.disposed) throw new Error("Redaction preview queue is closed");
      if (
        task.version ===
        this.version(task.request.sessionId, task.request.pageId)
      )
        this.remember(task.key, url);
      task.resolve(url);
    } catch (error) {
      task.reject(error);
    } finally {
      this.pending.delete(task.key);
      this.running--;
      this.pump();
    }
  }
  private remember(key: string, url: string): void {
    if (url.length > MAX_BYTES) return;
    while (
      this.cache.size >= MAX_ENTRIES ||
      this.bytes + url.length > MAX_BYTES
    ) {
      const first = this.cache.keys().next().value;
      if (!first) break;
      this.bytes -= this.cache.get(first)?.length ?? 0;
      this.cache.delete(first);
    }
    this.cache.set(key, url);
    this.bytes += url.length;
  }
}
