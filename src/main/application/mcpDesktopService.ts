import type { McpEditorState } from "../../shared/mcpEditingTypes";
import type {
  McpConnection,
  McpDesktopControl,
  McpDesktopStatus,
  McpDiagnostics,
  McpPreferences,
} from "../../shared/mcpDesktopTypes";

export type McpDesktopLease = {
  url: string;
  stopAccepting: () => void;
  close: () => Promise<void>;
  connections: () => McpConnection[];
  pairingStatus: () => Pick<McpDesktopStatus, "pending" | "pairingUntil">;
  beginPairing: () => void;
  resolvePairing: (id: string, approve: boolean) => void;
  revoke: (id: string) => Promise<void>;
};
type Ports = {
  reportEditorState: (state: McpEditorState) => void;
  preferences: () => Promise<McpPreferences>;
  savePreferences: (value: McpPreferences) => Promise<void>;
  savedStatus: () => Promise<{
    url: string | null;
    connections: McpConnection[];
  }>;
  revokeSaved: (id: string) => Promise<void>;
  open: (
    preferences: McpPreferences,
    signal: AbortSignal,
    failed: () => void,
  ) => Promise<McpDesktopLease>;
  diagnose: (url: string | null) => Promise<McpDiagnostics>;
  reportError: (error: unknown) => void;
  setupUrl: (error: unknown) => string | null;
};
/** Owns lifecycle and preferences. Adapter processes and Electron stay outside. */
export class McpDesktopService implements McpDesktopControl {
  private readonly status: McpDesktopStatus = {
    state: "off",
    provider: "tailscale",
    url: null,
    message: null,
    setupUrl: null,
    preferences: { allowImages: false, allowEditing: false, autoStart: false },
    pending: [],
    connections: [],
    pairingUntil: null,
  };
  private lease?: McpDesktopLease;
  private starting?: AbortController;
  private tail: Promise<unknown> = Promise.resolve();
  private wanted = false;
  private disposed = false;
  constructor(private readonly ports: Ports) {}
  async reportEditorState(state: McpEditorState) {
    this.ports.reportEditorState(state);
    return { completed: true };
  }
  async initialize(): Promise<void> {
    this.status.preferences = await this.ports.preferences();
    // Reading preferences must not require encryption; an unavailable key store
    // should prevent starting MCP, not starting the manga editor.
    try {
      Object.assign(this.status, await this.ports.savedStatus());
    } catch (error) {
      this.status.message =
        "MCP 인증 저장소를 열지 못했습니다. 서버 시작은 차단됩니다.";
      this.ports.reportError(error);
    }
    if (this.status.preferences.autoStart)
      void this.setEnabled(true).catch(this.ports.reportError);
  }
  async getStatus(): Promise<McpDesktopStatus> {
    if (this.lease) {
      Object.assign(this.status, this.lease.pairingStatus());
      this.status.connections = this.lease.connections();
    }
    return structuredClone(this.status);
  }
  setEnabled(enabled: boolean): Promise<McpDesktopStatus> {
    this.wanted = enabled;
    if (!enabled) {
      this.starting?.abort();
      this.lease?.stopAccepting();
    }
    return this.enqueue(async () => {
      if (this.wanted && !this.disposed) await this.start();
      else await this.stop();
      return this.getStatus();
    });
  }
  configure(preferences: McpPreferences): Promise<McpDesktopStatus> {
    return this.enqueue(async () => {
      await this.ports.savePreferences(preferences);
      this.status.preferences = structuredClone(preferences);
      if (this.lease) {
        await this.stop();
        if (this.wanted) await this.start();
      }
      return this.getStatus();
    });
  }
  beginPairing(): Promise<McpDesktopStatus> {
    return this.enqueue(async () => {
      this.requireOnline().beginPairing();
      return this.getStatus();
    });
  }
  resolvePairing(id: string, approve: boolean): Promise<McpDesktopStatus> {
    return this.enqueue(async () => {
      this.requireOnline().resolvePairing(id, approve);
      return this.getStatus();
    });
  }
  revokeConnection(id: string): Promise<McpDesktopStatus> {
    return this.enqueue(async () => {
      if (this.lease) await this.lease.revoke(id);
      else {
        await this.ports.revokeSaved(id);
        Object.assign(this.status, await this.ports.savedStatus());
      }
      return this.getStatus();
    });
  }
  diagnose(): Promise<McpDiagnostics> {
    return this.ports.diagnose(this.status.url);
  }
  stopAccepting(): void {
    this.disposed = true;
    this.wanted = false;
    this.starting?.abort();
    this.lease?.stopAccepting();
  }
  async dispose(): Promise<void> {
    this.stopAccepting();
    await this.enqueue(() => this.stop());
  }
  private requireOnline(): McpDesktopLease {
    if (this.status.state !== "online" || !this.lease)
      throw new Error("MCP 서버를 먼저 켜세요.");
    return this.lease;
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action, action);
    // The caller still receives rejection; the queue must remain usable for stop/retry.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private async start(): Promise<void> {
    if (this.lease) return;
    const controller = new AbortController();
    this.starting = controller;
    Object.assign(this.status, {
      state: "starting",
      message: null,
      setupUrl: null,
    });
    try {
      Object.assign(this.status, await this.ports.savedStatus());
      this.lease = await this.ports.open(
        this.status.preferences,
        controller.signal,
        () => this.connectionLost(),
      );
      this.status.url = this.lease.url;
      if (!this.wanted || this.disposed) await this.stop();
      else this.status.state = "online";
    } catch (error) {
      if (!controller.signal.aborted) {
        this.status.state = "error";
        this.status.message =
          error instanceof Error ? error.message : "MCP 시작 실패";
        this.status.setupUrl = this.ports.setupUrl(error);
        this.ports.reportError(error);
      } else this.status.state = "off";
    } finally {
      this.starting = undefined;
    }
  }
  private async stop(): Promise<void> {
    if (this.lease) {
      this.status.state = "stopping";
      this.status.connections = this.lease.connections();
      this.lease.stopAccepting();
      try {
        await this.lease.close();
        this.lease = undefined;
      } catch (error) {
        this.status.message =
          "MCP 접근은 차단했지만 연결 종료에 실패했습니다. 다시 끄기를 누르세요.";
        throw error;
      }
    }
    Object.assign(this.status, {
      state: "off",
      message: null,
      setupUrl: null,
      pending: [],
      pairingUntil: null,
    });
  }
  private connectionLost(): void {
    this.lease?.stopAccepting();
    void this.enqueue(async () => {
      await this.stop();
      this.status.state = "error";
      this.status.message =
        "Tailscale 연결이 종료되었습니다. 인증은 보존되었습니다. 다시 켜세요.";
    }).catch(this.ports.reportError);
  }
}
