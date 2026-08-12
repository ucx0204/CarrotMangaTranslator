import type { AppActivityLease } from "./appActivityGate";
import { AppActivityGate } from "./appActivityGate";

export type AppOperationKind =
  | "library-import"
  | "library-import-preview"
  | "work-share-import"
  | "work-share-export"
  | "model-test";

export type AppOperationSnapshot = {
  id: string;
  kind: AppOperationKind;
  mutatesLibrary: boolean;
  blocksQuit: boolean;
  startedAt: number;
};

export type AppOperationLease = {
  readonly id: string;
  readonly kind: AppOperationKind;
  readonly signal: AbortSignal;
  finish: () => void;
};

type AppOperationEntry = {
  token: symbol;
  snapshot: AppOperationSnapshot;
  abortController: AbortController;
  activityLease: AppActivityLease;
  completion: Promise<void>;
  resolveCompletion: () => void;
  finished: boolean;
};

export class AppOperationRegistry {
  private currentEntry: AppOperationEntry | null = null;

  constructor(private readonly activityGate: AppActivityGate) {}

  get current(): Readonly<AppOperationSnapshot> | null {
    return this.currentEntry ? { ...this.currentEntry.snapshot } : null;
  }

  get hasActive(): boolean {
    return this.currentEntry !== null;
  }

  begin(options: {
    id: string;
    kind: AppOperationKind;
    mutatesLibrary: boolean;
    blocksQuit?: boolean;
  }): AppOperationLease {
    const activityLease = this.activityGate.acquire({
      id: options.id,
      category: "operation",
      kind: options.kind,
      mutatesLibrary: options.mutatesLibrary,
      blocksQuit: options.blocksQuit ?? true,
    });

    const abortController = new AbortController();
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const token = Symbol(options.id);
    const entry: AppOperationEntry = {
      token,
      snapshot: {
        id: options.id,
        kind: options.kind,
        mutatesLibrary: options.mutatesLibrary,
        blocksQuit: options.blocksQuit ?? true,
        startedAt: activityLease.descriptor.startedAt,
      },
      abortController,
      activityLease,
      completion,
      resolveCompletion,
      finished: false,
    };

    this.currentEntry = entry;
    return {
      id: entry.snapshot.id,
      kind: entry.snapshot.kind,
      signal: entry.abortController.signal,
      finish: () => this.finishEntry(entry),
    };
  }

  async abortCurrentAndWait(
    reason: string,
  ): Promise<Readonly<AppOperationSnapshot> | null> {
    const entry = this.currentEntry;
    if (!entry) {
      return null;
    }

    if (!entry.abortController.signal.aborted) {
      entry.abortController.abort(
        new DOMException(`Operation aborted: ${reason}`, "AbortError"),
      );
    }

    await entry.completion;
    return { ...entry.snapshot };
  }

  private finishEntry(entry: AppOperationEntry): void {
    if (entry.finished) {
      return;
    }
    entry.finished = true;

    if (this.currentEntry?.token === entry.token) {
      this.currentEntry = null;
    }
    entry.activityLease.release();
    entry.resolveCompletion();
  }
}

export function runManagedAppOperation<T>(
  registry: AppOperationRegistry,
  options: {
    id: string;
    kind: AppOperationKind;
    mutatesLibrary: boolean;
    blocksQuit?: boolean;
  },
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const lease = registry.begin(options);
  return Promise.resolve()
    .then(() => run(lease.signal))
    .finally(() => {
      lease.finish();
    });
}
