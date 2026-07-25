export type AbortableExclusiveLease = {
  release: () => void;
};

type GateWaiter = {
  signal?: AbortSignal;
  onAbort: () => void;
  resolve: (lease: AbortableExclusiveLease) => void;
  reject: (error: Error) => void;
};

/**
 * A FIFO gate for resources whose underlying process can execute only one
 * request at a time. Queued cancellation never touches the active owner.
 */
export class AbortableExclusiveGate {
  private active = false;
  private readonly queue: GateWaiter[] = [];

  acquire(signal?: AbortSignal): Promise<AbortableExclusiveLease> {
    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }
    if (!this.active && this.queue.length === 0) {
      return Promise.resolve(this.createLease());
    }
    return new Promise<AbortableExclusiveLease>((resolve, reject) => {
      const waiter: GateWaiter = {
        signal,
        resolve,
        reject,
        onAbort: () => this.abortWaiter(waiter),
      };
      this.queue.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal?.aborted) {
        this.abortWaiter(waiter);
      }
    });
  }

  private createLease(): AbortableExclusiveLease {
    this.active = true;
    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.active = false;
        this.drain();
      },
    };
  }

  private abortWaiter(waiter: GateWaiter): void {
    const index = this.queue.indexOf(waiter);
    if (index < 0) {
      return;
    }
    this.queue.splice(index, 1);
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    waiter.reject(createAbortError());
    if (!this.active) {
      this.drain();
    }
  }

  private drain(): void {
    if (this.active) {
      return;
    }
    const waiter = this.queue.shift();
    if (!waiter) {
      return;
    }
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    if (waiter.signal?.aborted) {
      waiter.reject(createAbortError());
      this.drain();
      return;
    }
    waiter.resolve(this.createLease());
  }
}

function createAbortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}
