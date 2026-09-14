import { AsyncLocalStorage } from "node:async_hooks";

type LockMode = "read" | "write";

type QueuedOperation = {
  mode: LockMode;
  operation: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

export class AsyncReaderWriterLock {
  private activeReaders = 0;
  private writerActive = false;
  private queue: QueuedOperation[] = [];

  runRead<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue("read", operation);
  }

  runWrite<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue("write", operation);
  }

  private enqueue<T>(mode: LockMode, operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        mode,
        // A prior reader/writer drains this queue in its own async context.
        // Capture the caller's activity owner, settings and transaction context.
        operation: AsyncLocalStorage.bind(operation),
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.drain();
    });
  }

  private drain(): void {
    if (this.writerActive) {
      return;
    }

    const next = this.queue[0];
    if (!next) {
      return;
    }

    if (next.mode === "write") {
      if (this.activeReaders > 0) {
        return;
      }
      const operation = this.queue.shift();
      if (operation) {
        this.writerActive = true;
        void this.runQueuedOperation(operation).finally(() => {
          this.writerActive = false;
          this.drain();
        });
      }
      return;
    }

    for (
      let operation = this.queue[0];
      operation?.mode === "read" && !this.writerActive;
      operation = this.queue[0]
    ) {
      this.queue.shift();
      this.activeReaders += 1;
      void this.runQueuedOperation(operation).finally(() => {
        this.activeReaders -= 1;
        if (this.activeReaders === 0) {
          this.drain();
        }
      });
    }
  }

  private async runQueuedOperation(operation: QueuedOperation): Promise<void> {
    try {
      operation.resolve(await operation.operation());
    } catch (error) {
      operation.reject(error);
    }
  }
}
