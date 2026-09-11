import type {
  McpConnection,
  McpDesktopControl,
  McpDesktopStatus,
  McpDiagnostics,
  McpPairingRequest,
  McpPreferences,
} from "../../shared/mcpDesktopTypes";

export type McpDesktopLease = {
  url: string;
  stopAccepting: () => void;
  close: () => Promise<void>;
  pairing: () => { pairingUntil: number | null; pending: McpPairingRequest[] };
  beginPairing: () => void;
  resolvePairing: (id: string, approve: boolean) => void;
  connections: () => McpConnection[];
  revokeConnection: (id: string) => Promise<void>;
  diagnose: () => Promise<McpDiagnostics>;
};
type DesktopPort = {
  preferences: () => Promise<McpPreferences>;
  savePreferences: (value: McpPreferences) => Promise<void>;
  open: (
    preferences: McpPreferences,
    signal: AbortSignal,
    onSetup: (url: string) => void,
    onFailure: (error: Error) => void,
  ) => Promise<McpDesktopLease>;
  reportError: (error: unknown) => void;
  remembered?: (
    revokeId?: string,
  ) => Promise<{ url: string | null; connections: McpConnection[] }>;
};
/** Serializes control operations; off/quit synchronously invalidates in-flight startup and new requests. */
export class McpDesktopService implements McpDesktopControl {
  private status: McpDesktopStatus = {
    state: "off",
    provider: "tailscale",
    url: null,
    message: null,
    setupUrl: null,
    preferences: { allowImages: false, allowEditing: false, autoStart: false },
    pairingUntil: null,
    pending: [],
    connections: [],
  };
  private ready?: Promise<void>;
  private tail: Promise<void> = Promise.resolve();
  private lease?: McpDesktopLease;
  private abort?: AbortController;
  private version = 0;
  private disposed = false;
  constructor(private readonly port: DesktopPort) {}
  async initialize(): Promise<void> {
    await this.load();
    if (this.status.preferences.autoStart) await this.setEnabled(true);
  }
  async getStatus(): Promise<McpDesktopStatus> {
    await this.load();
    if (this.lease && this.status.state === "online") {
      Object.assign(this.status, this.lease.pairing());
      this.status.connections = this.lease.connections();
    }
    return structuredClone(this.status);
  }
  setEnabled(enabled: boolean): Promise<McpDesktopStatus> {
    const version = ++this.version;
    if (!enabled) this.stopAccepting();
    return this.enqueue(async () => {
      if (enabled && version === this.version) await this.open();
      else if (!enabled) await this.close();
    });
  }
  configure(preferences: McpPreferences): Promise<McpDesktopStatus> {
    return this.enqueue(async () => {
      if (this.status.state === "error") await this.close();
      if (this.lease || this.status.state === "starting")
        throw new Error("Turn off MCP before changing permissions.");
      await this.port.savePreferences(preferences);
      this.status.preferences = { ...preferences };
    });
  }
  beginPairing(): Promise<McpDesktopStatus> {
    return this.enqueue(async () => this.online().beginPairing());
  }
  resolvePairing(id: string, approved: boolean): Promise<McpDesktopStatus> {
    return this.enqueue(async () => this.online().resolvePairing(id, approved));
  }
  revokeConnection(id: string): Promise<McpDesktopStatus> {
    return this.enqueue(async () => {
      if (this.lease) await this.online().revokeConnection(id);
      else if (this.port.remembered)
        Object.assign(this.status, await this.port.remembered(id));
      else throw new Error("No saved MCP authorization store is available.");
    });
  }
  diagnose(): Promise<McpDiagnostics> {
    return this.online().diagnose();
  }
  stopAccepting(): void {
    this.abort?.abort();
    this.lease?.stopAccepting();
    this.status.pending = [];
    this.status.pairingUntil = null;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    ++this.version;
    this.stopAccepting();
    await this.tail;
    await this.close();
  }
  private load(): Promise<void> {
    this.ready ??= this.port.preferences().then(async (value) => {
      this.status.preferences = value;
      if (this.port.remembered)
        Object.assign(this.status, await this.port.remembered());
    });
    return this.ready;
  }
  private enqueue(action: () => Promise<void>): Promise<McpDesktopStatus> {
    const next = this.tail.then(async () => {
      if (this.disposed) throw new Error("MCP is shutting down.");
      await this.load();
      await action();
      return this.getStatus();
    });
    this.tail = next.then(
      () => undefined,
      (error) => {
        this.port.reportError(error);
      },
    );
    return next;
  }
  private online(): McpDesktopLease {
    if (!this.lease || this.status.state !== "online")
      throw new Error("Enable MCP first.");
    return this.lease;
  }
  private async open(): Promise<void> {
    if (this.lease && this.status.state === "online") return;
    if (this.lease) await this.close();
    this.status.state = "starting";
    this.status.message = null;
    this.status.setupUrl = null;
    const abort = new AbortController();
    this.abort = abort;
    try {
      this.lease = await this.port.open(
        this.status.preferences,
        abort.signal,
        (url) => {
          this.status.setupUrl = url;
        },
        (error) => this.failed(error),
      );
      if (abort.signal.aborted || this.disposed) {
        await this.close();
        return;
      }
      this.status.url = this.lease.url;
      this.status.state = "online";
      this.status.setupUrl = null;
    } catch (error) {
      this.status.state =
        abort.signal.aborted && !this.status.message ? "off" : "error";
      if (this.status.state === "error")
        this.status.message =
          error instanceof Error ? error.message : "MCP startup failed.";
      this.port.reportError(error);
    }
  }
  private failed(error: Error): void {
    this.status.message = error.message;
    this.status.state = "error";
    this.stopAccepting();
    this.port.reportError(error);
  }
  private async close(): Promise<void> {
    const lease = this.lease;
    this.stopAccepting();
    if (lease) this.status.connections = lease.connections();
    this.lease = undefined;
    this.status.state = "stopping";
    try {
      await lease?.close();
      this.status.state = "off";
      this.status.message = null;
    } catch (error) {
      this.status.state = "error";
      this.status.message =
        "MCP cleanup failed. Check the local log before restarting.";
      throw error;
    }
  }
}
