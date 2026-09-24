import type {
  McpCompositeGuard,
  McpCompositeRecord,
} from "./mcpCompositeWorkflowPorts";

/** One exact admission identity survives verification, durable reservation and physical cleanup. */
export class McpCompositeRunLifetime {
  readonly id: string;
  readonly owner: string;
  readonly abort = new AbortController();
  readonly done: Promise<void>;
  pause = false;
  started = false;
  private settled = false;
  private resolve!: () => void;
  private reject!: (error: unknown) => void;

  constructor(
    record: McpCompositeRecord,
    private readonly release: () => void,
    reportError?: (error: unknown) => void,
  ) {
    this.id = record.id;
    this.owner = record.owner;
    this.done = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // Observing this promise does not replace the original rejection awaited by control/close.
    void this.done.catch((error) => {
      if (this.started) reportError?.(error);
    });
  }

  guard(guard: McpCompositeGuard): McpCompositeGuard {
    return (scopes) => {
      this.abort.signal.throwIfAborted();
      guard(scopes);
    };
  }

  finish(failure?: { error: unknown }) {
    if (this.settled) return;
    this.settled = true;
    this.release();
    if (
      failure &&
      (this.started ||
        !this.abort.signal.aborted ||
        failure.error !== this.abort.signal.reason)
    )
      this.reject(failure.error);
    else this.resolve();
  }
}
