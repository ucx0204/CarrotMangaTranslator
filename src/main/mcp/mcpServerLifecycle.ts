type ServerLease = {
  stopAccepting: () => void;
  close: () => Promise<void>;
};

type StartOutcome =
  | { kind: "ready"; server: ServerLease | null }
  | { kind: "failed"; error: unknown };

/** Owns the listener even if application shutdown overtakes asynchronous startup. */
export class McpServerLifecycle {
  private readonly createServer: () => Promise<ServerLease | null>;
  private opening?: Promise<StartOutcome>;
  private closing?: Promise<void>;
  private server: ServerLease | null = null;
  private stopped = false;

  constructor(createServer: () => Promise<ServerLease | null>) {
    this.createServer = createServer;
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error("MCP lifecycle is already stopped.");
    this.opening ??= this.open();
    const outcome = await this.opening;
    if (outcome.kind === "failed") throw outcome.error;
    if (this.stopped) await this.dispose();
  }

  stopAccepting(): void {
    this.stopped = true;
    this.server?.stopAccepting();
  }

  dispose(): Promise<void> {
    this.stopAccepting();
    this.closing ??= this.finishClose();
    return this.closing;
  }

  private async open(): Promise<StartOutcome> {
    try {
      this.server = await this.createServer();
      return { kind: "ready", server: this.server };
    } catch (error) {
      // Retain the failure for start(); disposal has no acquired lease to release.
      return { kind: "failed", error };
    }
  }

  private async finishClose(): Promise<void> {
    const outcome = await this.opening;
    if (outcome?.kind === "ready") {
      outcome.server?.stopAccepting();
      await outcome.server?.close();
    }
  }
}
