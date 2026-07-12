export type LeasedIdleResourceLease<TResource> = {
  resource: TResource;
  reused: boolean;
  release: () => void;
};

type LeasedIdleResourceEntry<TResource> = {
  key: string;
  resource: TResource;
  activeLeases: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  disposeReason: string | null;
  disposePromise: Promise<void> | null;
  releaseWaiters: Set<() => void>;
  disposed: boolean;
};

export type LeasedIdleResourcePoolOptions<TResource> = {
  idleTtlMs: number;
  isReusable: (resource: TResource) => boolean;
  dispose: (resource: TResource, reason: string) => Promise<void>;
};

/**
 * Owns one reusable resource while allowing an already-leased replacement to
 * retire safely. Every release closure is bound to its own entry, so stale or
 * duplicate releases cannot affect a newer resource.
 */
export class LeasedIdleResourcePool<TResource> {
  private readonly entries = new Set<LeasedIdleResourceEntry<TResource>>();
  private current: LeasedIdleResourceEntry<TResource> | null = null;
  private transitionTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: LeasedIdleResourcePoolOptions<TResource>,
  ) {}

  acquire(
    key: string,
    create: () => Promise<TResource>,
  ): Promise<LeasedIdleResourceLease<TResource>> {
    return this.runTransition(async () => {
      const existing = this.current;
      if (
        existing &&
        !existing.disposePromise &&
        existing.key === key &&
        this.options.isReusable(existing.resource)
      ) {
        this.clearIdleTimer(existing);
        return this.createLease(existing, true);
      }

      if (existing) {
        const reason = existing.key === key ? "unhealthy-worker" : "replace";
        await this.requestDisposal(existing, reason);
      }

      const entry: LeasedIdleResourceEntry<TResource> = {
        key,
        resource: await create(),
        activeLeases: 0,
        idleTimer: null,
        disposeReason: null,
        disposePromise: null,
        releaseWaiters: new Set(),
        disposed: false,
      };
      this.entries.add(entry);
      this.current = entry;
      return this.createLease(entry, false);
    });
  }

  dispose(reason: string): Promise<boolean> {
    return this.runTransition(async () => {
      const entries = [...this.entries].filter((entry) => !entry.disposed);
      if (entries.length === 0) {
        return false;
      }

      this.current = null;
      await Promise.all(
        entries.map((entry) => this.requestDisposal(entry, reason)),
      );
      return true;
    });
  }

  private createLease(
    entry: LeasedIdleResourceEntry<TResource>,
    reused: boolean,
  ): LeasedIdleResourceLease<TResource> {
    entry.activeLeases += 1;
    let released = false;
    return {
      resource: entry.resource,
      reused,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.releaseEntry(entry);
      },
    };
  }

  private releaseEntry(entry: LeasedIdleResourceEntry<TResource>): void {
    if (entry.disposed || entry.activeLeases === 0) {
      return;
    }
    entry.activeLeases -= 1;
    if (entry.activeLeases > 0) {
      return;
    }

    for (const resolve of entry.releaseWaiters) {
      resolve();
    }
    entry.releaseWaiters.clear();

    if (entry.disposePromise) {
      return;
    }
    entry.idleTimer = setTimeout(() => {
      void this.requestDisposal(entry, "idle-ttl");
    }, this.options.idleTtlMs);
  }

  private requestDisposal(
    entry: LeasedIdleResourceEntry<TResource>,
    reason: string,
  ): Promise<void> {
    if (entry.disposePromise) {
      return entry.disposePromise;
    }
    this.clearIdleTimer(entry);
    entry.disposeReason = reason;
    entry.disposePromise = this.disposeWhenReleased(entry);
    return entry.disposePromise;
  }

  private async disposeWhenReleased(
    entry: LeasedIdleResourceEntry<TResource>,
  ): Promise<void> {
    if (entry.activeLeases > 0) {
      await new Promise<void>((resolve) => {
        entry.releaseWaiters.add(resolve);
      });
    }

    try {
      await this.options.dispose(
        entry.resource,
        entry.disposeReason ?? "dispose",
      );
    } finally {
      entry.disposed = true;
      this.entries.delete(entry);
      if (this.current === entry) {
        this.current = null;
      }
    }
  }

  private clearIdleTimer(entry: LeasedIdleResourceEntry<TResource>): void {
    if (!entry.idleTimer) {
      return;
    }
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  private async runTransition<TResult>(
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    const previous = this.transitionTail;
    let finishTransition: () => void = () => undefined;
    this.transitionTail = new Promise<void>((resolve) => {
      finishTransition = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      finishTransition();
    }
  }
}
