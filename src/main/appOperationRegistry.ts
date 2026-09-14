import type { AppActivityLease } from "./appActivityGate";
import { AppActivityGate } from "./appActivityGate";
import type { AppActivityResource } from "../shared/appActivityTypes";
import { isAbortErrorLike } from "./abortSignal";
import { withLibraryActivityOwner } from "./library/lock";
import type {
  AppOperationActivityEvent,
  AppOperationKind,
  AppOperationPhase,
} from "../shared/appOperationTypes";

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
  updateActivity: (update: AppOperationActivityUpdate) => void;
  finish: (
    status?: "completed" | "cancelled" | "failed",
    failureCode?: string,
  ) => void;
};

export type AppOperationPresentation = {
  phase?: AppOperationPhase;
  sourceKind?: AppOperationActivityEvent["sourceKind"];
  cancellable?: boolean;
  progressCurrent?: number;
  progressTotal?: number;
  progressUnit?: AppOperationActivityEvent["progressUnit"];
  waitingForUser?: boolean;
};

export type AppOperationActivityUpdate = Partial<
  Pick<
    AppOperationActivityEvent,
    | "phase"
    | "sourceKind"
    | "cancellable"
    | "progressCurrent"
    | "progressTotal"
    | "progressUnit"
    | "waitingForUser"
  >
>;

type AppOperationEntry = {
  token: symbol;
  snapshot: AppOperationSnapshot;
  abortController: AbortController;
  activityLease: AppActivityLease;
  completion: Promise<void>;
  resolveCompletion: () => void;
  finished: boolean;
  activity: AppOperationActivityEvent | null;
};

type AppOperationActivityListener = (
  event: Readonly<AppOperationActivityEvent>,
) => void;

export class AppOperationRegistry {
  private readonly entries = new Map<string, AppOperationEntry>();
  private readonly activityListeners = new Set<AppOperationActivityListener>();

  constructor(private readonly activityGate: AppActivityGate) {}

  get current(): Readonly<AppOperationSnapshot> | null {
    const entry = this.entries.values().next().value;
    return entry ? { ...entry.snapshot } : null;
  }

  get hasActive(): boolean {
    return this.entries.size > 0;
  }

  get currentActivity(): Readonly<AppOperationActivityEvent> | null {
    const entry = this.entries.values().next().value;
    return entry?.activity ? { ...entry.activity } : null;
  }

  get activities(): AppOperationActivityEvent[] {
    return [...this.entries.values()].flatMap((entry) =>
      entry.activity ? [{ ...entry.activity }] : [],
    );
  }

  subscribeActivity(listener: AppOperationActivityListener): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  begin(options: {
    id: string;
    kind: AppOperationKind;
    mutatesLibrary: boolean;
    blocksQuit?: boolean;
    presentation?: AppOperationPresentation;
    resources?: readonly AppActivityResource[];
  }): AppOperationLease {
    if (this.entries.has(options.id))
      throw new Error("Operation id is already active.");
    const activityLease = this.activityGate.acquire({
      id: options.id,
      category: "operation",
      kind: options.kind,
      mutatesLibrary: options.mutatesLibrary,
      blocksQuit: options.blocksQuit ?? true,
      resources: options.resources,
    });

    const abortController = new AbortController();
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const token = Symbol(options.id);
    const startedAt = activityLease.descriptor.startedAt;
    const entry: AppOperationEntry = {
      token,
      snapshot: {
        id: options.id,
        kind: options.kind,
        mutatesLibrary: options.mutatesLibrary,
        blocksQuit: options.blocksQuit ?? true,
        startedAt,
      },
      abortController,
      activityLease,
      completion,
      resolveCompletion,
      finished: false,
      activity: options.presentation
        ? {
            id: options.id,
            kind: options.kind,
            status: "running",
            ...(options.presentation.phase
              ? { phase: options.presentation.phase }
              : {}),
            ...(options.presentation.sourceKind
              ? { sourceKind: options.presentation.sourceKind }
              : {}),
            ...(options.presentation.progressCurrent !== undefined
              ? { progressCurrent: options.presentation.progressCurrent }
              : {}),
            ...(options.presentation.progressTotal !== undefined
              ? { progressTotal: options.presentation.progressTotal }
              : {}),
            ...(options.presentation.progressUnit
              ? { progressUnit: options.presentation.progressUnit }
              : {}),
            ...(options.presentation.waitingForUser !== undefined
              ? { waitingForUser: options.presentation.waitingForUser }
              : {}),
            mutatesLibrary: options.mutatesLibrary,
            cancellable: options.presentation.cancellable ?? true,
            startedAt,
            updatedAt: startedAt,
          }
        : null,
    };

    this.entries.set(options.id, entry);
    this.emitActivity(entry);
    return {
      id: entry.snapshot.id,
      kind: entry.snapshot.kind,
      signal: entry.abortController.signal,
      updateActivity: (update) => this.updateActivity(entry, update),
      finish: (status, failureCode) =>
        this.finishEntry(entry, status, failureCode),
    };
  }

  requestCancel(id: string): boolean {
    const entry = this.entries.get(id);
    if (
      !entry ||
      entry.snapshot.id !== id ||
      !entry.activity?.cancellable ||
      entry.activity.status !== "running"
    ) {
      return false;
    }
    this.markCancelling(entry);
    this.abortEntry(entry, "user-request");
    return true;
  }

  async abortCurrentAndWait(
    reason: string,
  ): Promise<Readonly<AppOperationSnapshot> | null> {
    const entries = [...this.entries.values()];
    for (const entry of entries) {
      this.markCancelling(entry);
      this.abortEntry(entry, reason);
    }
    await Promise.all(entries.map((entry) => entry.completion));
    return entries[0] ? { ...entries[0].snapshot } : null;
  }

  private updateActivity(
    entry: AppOperationEntry,
    update: AppOperationActivityUpdate,
  ): void {
    if (
      entry.finished ||
      !entry.activity ||
      entry.activity.status !== "running"
    ) {
      return;
    }
    entry.activity = {
      ...entry.activity,
      ...update,
      updatedAt: Date.now(),
    };
    this.emitActivity(entry);
  }

  private markCancelling(entry: AppOperationEntry): void {
    if (
      !entry.activity ||
      entry.finished ||
      entry.activity.status !== "running"
    ) {
      return;
    }
    entry.activity = {
      ...entry.activity,
      status: "cancelling",
      cancellable: false,
      updatedAt: Date.now(),
    };
    this.emitActivity(entry);
  }

  private abortEntry(entry: AppOperationEntry, reason: string): void {
    if (!entry.abortController.signal.aborted) {
      entry.abortController.abort(
        new DOMException(`Operation aborted: ${reason}`, "AbortError"),
      );
    }
  }

  private finishEntry(
    entry: AppOperationEntry,
    requestedStatus?: "completed" | "cancelled" | "failed",
    failureCode?: string,
  ): void {
    if (entry.finished) {
      return;
    }
    entry.finished = true;

    if (entry.activity) {
      entry.activity = {
        ...entry.activity,
        status:
          requestedStatus ??
          (entry.abortController.signal.aborted ? "cancelled" : "completed"),
        cancellable: false,
        ...(failureCode ? { failureCode } : {}),
        updatedAt: Date.now(),
      };
      this.emitActivity(entry);
    }

    if (this.entries.get(entry.snapshot.id)?.token === entry.token) {
      this.entries.delete(entry.snapshot.id);
    }
    entry.activityLease.release();
    entry.resolveCompletion();
  }

  private emitActivity(entry: AppOperationEntry): void {
    if (!entry.activity) {
      return;
    }
    const event = { ...entry.activity };
    for (const listener of this.activityListeners) {
      try {
        listener(event);
      } catch (error) {
        // Presentation listeners must never change operation semantics.
        void error;
      }
    }
  }
}

export function runManagedAppOperation<T>(
  registry: AppOperationRegistry,
  options: {
    id: string;
    kind: AppOperationKind;
    mutatesLibrary: boolean;
    blocksQuit?: boolean;
    presentation?: AppOperationPresentation;
    resources?: readonly AppActivityResource[];
  },
  run: (signal: AbortSignal, lease: AppOperationLease) => Promise<T>,
): Promise<T> {
  const lease = registry.begin(options);
  let execution: Promise<T>;
  try {
    // Start the body before returning control so an immediately delivered cancel
    // cannot beat the operation's first abort listener.
    execution = Promise.resolve(
      withLibraryActivityOwner(options.id, () => run(lease.signal, lease)),
    );
  } catch (error) {
    const cancelled = lease.signal.aborted || isAbortErrorLike(error);
    lease.finish(
      cancelled ? "cancelled" : "failed",
      cancelled ? undefined : safeFailureCode(error),
    );
    return Promise.reject(error);
  }
  return execution.then(
    (result) => {
      lease.finish("completed");
      return result;
    },
    (error) => {
      const cancelled = lease.signal.aborted || isAbortErrorLike(error);
      lease.finish(
        cancelled ? "cancelled" : "failed",
        cancelled ? undefined : safeFailureCode(error),
      );
      throw error;
    },
  );
}

function safeFailureCode(error: unknown): string {
  const candidate =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : error instanceof Error
        ? error.name
        : "OPERATION_FAILED";
  const normalized = candidate
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || "OPERATION_FAILED";
}
