/** Tracks durable editor work separately from gestures, so handoff cannot overtake a brush IPC. */
class PageEditBarrier {
  private environmentFlushers = new Set<() => Promise<void>>();
  registerEnvironmentFlusher(flush: () => Promise<void>): () => void {
    this.environmentFlushers.add(flush);
    return () => {
      this.environmentFlushers.delete(flush);
    };
  }
  async flushEnvironment(): Promise<void> {
    await Promise.all([...this.environmentFlushers].map((flush) => flush()));
  }
  private readonly counts = new Map<string, number>();
  private readonly failures = new Map<string, unknown>();
  private readonly listeners = new Set<() => void>();
  private readonly flushers = new Set<
    (chapterId: string, pageId: string) => Promise<void>
  >();
  private activePages: ReadonlySet<string> = new Set();
  private handingOff = new Set<string>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getActivePages = (): ReadonlySet<string> => this.activePages;

  setHandingOff(pageIds: Iterable<string>): void {
    this.handingOff = new Set(pageIds);
  }

  isHandingOff(pageId: string | undefined): boolean {
    return Boolean(pageId && this.handingOff.has(pageId));
  }

  registerFlusher(
    flush: (chapterId: string, pageId: string) => Promise<void>,
  ): () => void {
    this.flushers.add(flush);
    return () => this.flushers.delete(flush);
  }

  async flushEditors(chapterId: string, pageId: string): Promise<void> {
    await Promise.all(
      [...this.flushers].map((flush) => flush(chapterId, pageId)),
    );
    await this.waitForIdle(chapterId, pageId);
  }

  private emit(): void {
    this.activePages = new Set(
      [...this.counts].filter(([, count]) => count > 0).map(([key]) => key),
    );
    for (const listener of this.listeners) listener();
  }

  begin(chapterId: string, pageId: string): (error?: unknown) => void {
    const key = `${chapterId}/${pageId}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.emit();
    let finished = false;
    return (error) => {
      if (finished) return;
      finished = true;
      this.counts.set(key, Math.max(0, (this.counts.get(key) ?? 1) - 1));
      if (error) this.failures.set(key, error);
      this.emit();
    };
  }

  async waitForIdle(chapterId: string, pageId: string): Promise<void> {
    const key = `${chapterId}/${pageId}`;
    await new Promise<void>((resolve) => {
      const check = () => {
        if ((this.counts.get(key) ?? 0) > 0) return;
        this.listeners.delete(check);
        this.counts.delete(key);
        resolve();
      };
      this.listeners.add(check);
      check();
    });
    const error = this.failures.get(key);
    this.failures.delete(key);
    if (error) throw error;
  }
}

export const pendingPageEdits = new PageEditBarrier();
