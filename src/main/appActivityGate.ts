import {
  activityResourcesConflict,
  activityConflictReason,
  type AppActivityResource,
} from "../shared/appActivityTypes";
import { logError } from "./logger";

export type AppActivityCategory = "job" | "operation";

export type AppActivityDescriptor = {
  id: string;
  ownerId?: string;
  category: AppActivityCategory;
  kind: string;
  mutatesLibrary: boolean;
  blocksQuit: boolean;
  startedAt: number;
  resources?: readonly AppActivityResource[];
};

export type AppActivityLease = {
  readonly descriptor: Readonly<AppActivityDescriptor>;
  release: () => void;
  updateResources: (resources: readonly AppActivityResource[]) => void;
};

export type AppActivitySuspensionLease = {
  release: () => void;
};

export class AppActivityBusyError extends Error {
  readonly code = "APP_ACTIVITY_BUSY";
  readonly current: Readonly<AppActivityDescriptor>;

  constructor(
    current: Readonly<AppActivityDescriptor>,
    requested?: readonly AppActivityResource[],
  ) {
    const resource =
      requested?.find((resource) =>
        activityResourcesConflict([resource], current.resources),
      ) ?? current.resources?.[0];
    super(
      `[APP_ACTIVITY_BUSY] ${resource ? activityConflictReason(resource.kind) : "다른 작업이 진행 중입니다."}`,
    );
    this.name = "AppActivityBusyError";
    this.current = { ...current };
  }
}

export class AppActivityClosedError extends Error {
  readonly code = "APP_ACTIVITY_CLOSED";

  constructor(message = "Application activity intake is closed.") {
    super(message);
    this.name = "AppActivityClosedError";
  }
}

export function isAppActivityUnavailableError(error: unknown): boolean {
  return (
    error instanceof AppActivityBusyError ||
    error instanceof AppActivityClosedError
  );
}

export class AppActivityGate {
  private readonly entries = new Map<symbol, AppActivityDescriptor>();
  private readonly listeners = new Set<() => void>();

  private permanentlyClosed = false;
  private readonly suspensionTokens = new Set<symbol>();

  get current(): Readonly<AppActivityDescriptor> | null {
    return this.activities[0] ?? null;
  }

  get activities(): AppActivityDescriptor[] {
    return Array.from(this.entries.values(), (entry) => structuredClone(entry));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  findConflict(
    resources: readonly AppActivityResource[] | undefined,
    ownerId?: string,
  ): AppActivityDescriptor | null {
    return (
      this.activities.find(
        (entry) =>
          (!ownerId || (entry.ownerId ?? entry.id) !== ownerId) &&
          activityResourcesConflict(resources, entry.resources),
      ) ?? null
    );
  }

  assertAvailable(
    resources: readonly AppActivityResource[],
    ownerId?: string,
  ): void {
    if (this.permanentlyClosed || this.suspensionTokens.size > 0)
      throw new AppActivityClosedError();
    const conflict = this.findConflict(resources, ownerId);
    if (conflict) throw new AppActivityBusyError(conflict, resources);
  }

  waitForAvailable(
    resources: readonly AppActivityResource[] | undefined,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        unsubscribe();
        signal.removeEventListener("abort", check);
      };
      const check = () => {
        if (signal.aborted) {
          cleanup();
          reject(signal.reason);
        } else if (this.permanentlyClosed || this.suspensionTokens.size > 0) {
          cleanup();
          reject(new AppActivityClosedError());
        } else if (!this.findConflict(resources, ownerId)) {
          cleanup();
          resolve();
        }
      };
      const unsubscribe = this.subscribe(check);
      signal.addEventListener("abort", check, { once: true });
      check();
    });
  }

  get isUnavailable(): boolean {
    return (
      this.permanentlyClosed ||
      this.suspensionTokens.size > 0 ||
      this.entries.size > 0
    );
  }

  async acquireWhenAvailable(
    input: Omit<AppActivityDescriptor, "startedAt">,
    signal: AbortSignal,
  ): Promise<AppActivityLease> {
    for (;;) {
      signal.throwIfAborted();
      try {
        return this.acquire(input);
      } catch (error) {
        if (!(error instanceof AppActivityBusyError)) throw error;
        await this.waitForAvailable(
          input.resources,
          input.ownerId ?? input.id,
          signal,
        );
      }
    }
  }

  acquire(
    input: Omit<AppActivityDescriptor, "startedAt"> & { startedAt?: number },
  ): AppActivityLease {
    if (this.permanentlyClosed || this.suspensionTokens.size > 0) {
      throw new AppActivityClosedError();
    }

    const conflict = this.findConflict(input.resources, input.ownerId);
    if (conflict) throw new AppActivityBusyError(conflict, input.resources);

    const descriptor = normalizeDescriptor(input);
    const token = Symbol(descriptor.id);
    this.entries.set(token, descriptor);
    this.emit();

    let released = false;
    return {
      descriptor: { ...descriptor },
      updateResources: (resources) => {
        if (released) throw new Error("Activity lease is already released.");
        const conflict = this.findConflict(
          resources,
          descriptor.ownerId ?? descriptor.id,
        );
        if (conflict) throw new AppActivityBusyError(conflict, resources);
        descriptor.resources = structuredClone(resources);
        this.emit();
      },
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.entries.delete(token);
        this.emit();
      },
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        // Observers cannot change ownership or strand a lease.
        logError("Activity observer failed", error);
      }
    }
  }

  closeToNewActivities(): void {
    this.permanentlyClosed = true;
    this.emit();
  }

  suspendNewActivities(): AppActivitySuspensionLease {
    const token = Symbol("app-activity-suspension");
    this.suspensionTokens.add(token);
    this.emit();

    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.suspensionTokens.delete(token);
      },
    };
  }
}

function normalizeDescriptor(
  input: Omit<AppActivityDescriptor, "startedAt"> & { startedAt?: number },
): AppActivityDescriptor {
  if (typeof input.id !== "string" || input.id.trim().length === 0) {
    throw new TypeError("Application activity id must be a non-empty string.");
  }
  if (input.category !== "job" && input.category !== "operation") {
    throw new TypeError("Application activity category is invalid.");
  }
  if (typeof input.kind !== "string" || input.kind.trim().length === 0) {
    throw new TypeError(
      "Application activity kind must be a non-empty string.",
    );
  }
  if (typeof input.mutatesLibrary !== "boolean") {
    throw new TypeError("Application activity mutatesLibrary must be boolean.");
  }
  if (typeof input.blocksQuit !== "boolean") {
    throw new TypeError("Application activity blocksQuit must be boolean.");
  }
  const startedAt = input.startedAt ?? Date.now();
  if (!Number.isFinite(startedAt)) {
    throw new TypeError("Application activity startedAt must be finite.");
  }

  return {
    id: input.id,
    ownerId: input.ownerId,
    category: input.category,
    kind: input.kind,
    mutatesLibrary: input.mutatesLibrary,
    blocksQuit: input.blocksQuit,
    startedAt,
    ...(input.resources ? { resources: structuredClone(input.resources) } : {}),
  };
}
