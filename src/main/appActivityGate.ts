export type AppActivityCategory = "job" | "operation";

export type AppActivityDescriptor = {
  id: string;
  category: AppActivityCategory;
  kind: string;
  mutatesLibrary: boolean;
  blocksQuit: boolean;
  startedAt: number;
};

export type AppActivityLease = {
  readonly descriptor: Readonly<AppActivityDescriptor>;
  release: () => void;
};

export type AppActivitySuspensionLease = {
  release: () => void;
};

export class AppActivityBusyError extends Error {
  readonly code = "APP_ACTIVITY_BUSY";
  readonly current: Readonly<AppActivityDescriptor>;

  constructor(current: Readonly<AppActivityDescriptor>) {
    super("Application activity is already in progress.");
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
  private currentEntry: {
    token: symbol;
    descriptor: AppActivityDescriptor;
  } | null = null;

  private permanentlyClosed = false;
  private readonly suspensionTokens = new Set<symbol>();

  get current(): Readonly<AppActivityDescriptor> | null {
    return this.currentEntry ? { ...this.currentEntry.descriptor } : null;
  }

  get isUnavailable(): boolean {
    return (
      this.permanentlyClosed ||
      this.suspensionTokens.size > 0 ||
      this.currentEntry !== null
    );
  }

  acquire(
    input: Omit<AppActivityDescriptor, "startedAt"> & { startedAt?: number },
  ): AppActivityLease {
    if (this.permanentlyClosed || this.suspensionTokens.size > 0) {
      throw new AppActivityClosedError();
    }

    if (this.currentEntry) {
      throw new AppActivityBusyError(this.currentEntry.descriptor);
    }

    const descriptor = normalizeDescriptor(input);
    const token = Symbol(descriptor.id);
    this.currentEntry = { token, descriptor };

    let released = false;
    return {
      descriptor: { ...descriptor },
      release: () => {
        if (released) {
          return;
        }
        released = true;
        if (this.currentEntry?.token === token) {
          this.currentEntry = null;
        }
      },
    };
  }

  closeToNewActivities(): void {
    this.permanentlyClosed = true;
  }

  suspendNewActivities(): AppActivitySuspensionLease {
    const token = Symbol("app-activity-suspension");
    this.suspensionTokens.add(token);

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
    category: input.category,
    kind: input.kind,
    mutatesLibrary: input.mutatesLibrary,
    blocksQuit: input.blocksQuit,
    startedAt,
  };
}
