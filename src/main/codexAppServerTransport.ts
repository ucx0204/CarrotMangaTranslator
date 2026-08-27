import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { asRecord, type JsonRecord } from "./codexAppServerProtocol";

const RPC_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RECENT_NOTIFICATIONS = 256;
const MAX_STDERR_LINES = 24;
const MAX_STDERR_LINE_LENGTH = 2_000;

type NotificationListener = (notification: JsonRecord) => void;
type FailureListener = (error: Error) => void;

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class CodexAppServerTransport {
  readonly version: string;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<NotificationListener>();
  private readonly failureListeners = new Set<FailureListener>();
  private readonly recentNotifications: JsonRecord[] = [];
  private readonly recentStderr: string[] = [];
  private nextRequestId = 1;
  private closed = false;
  private exitError: Error | null = null;

  constructor(child: ChildProcessWithoutNullStreams, version: string) {
    this.child = child;
    this.version = version;
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.handleStdoutLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.captureStderr(chunk));
    child.once("error", (error) => this.handleProcessFailure(error));
    child.once("exit", (code, signal) => {
      if (this.closed) return;
      this.handleProcessFailure(
        new Error(
          `Codex App Server가 예기치 않게 종료되었습니다. (code=${String(code)}, signal=${String(signal)})`,
        ),
      );
    });
  }

  get process(): ChildProcessWithoutNullStreams {
    return this.child;
  }

  request(
    method: string,
    params?: unknown,
    timeoutMs = RPC_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.exitError) return Promise.reject(this.exitError);
    if (this.closed) {
      return Promise.reject(
        new Error("Codex App Server 연결이 닫혀 있습니다."),
      );
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`Codex App Server 요청 시간이 초과되었습니다: ${method}`),
        );
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });
      try {
        this.writeMessage({
          id,
          method,
          ...(params === undefined ? {} : { params }),
        });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(normalizeError(error));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.writeMessage({ method, ...(params === undefined ? {} : { params }) });
  }

  waitForNotification(
    predicate: (notification: JsonRecord) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    const recent = [...this.recentNotifications].reverse().find(predicate);
    if (recent) return Promise.resolve(recent);
    if (this.exitError) return Promise.reject(this.exitError);
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        this.listeners.delete(listener);
        this.failureListeners.delete(onFailure);
        signal?.removeEventListener("abort", onAbort);
      };
      const listener: NotificationListener = (notification) => {
        if (!predicate(notification)) return;
        cleanup();
        resolve(notification);
      };
      const onAbort = () => {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };
      const onFailure: FailureListener = (error) => {
        cleanup();
        reject(error);
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Codex App Server 응답 대기 시간이 초과되었습니다."));
      }, timeoutMs);
      this.listeners.add(listener);
      this.failureListeners.add(onFailure);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    const error = new Error("Codex App Server 연결이 종료되었습니다.");
    this.rejectPending(error);
    this.rejectWaiters(error);
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    if (await waitForProcessExit(this.child, 1_500)) return;
    if (!this.child.killed) this.child.kill();
    await waitForProcessExit(this.child, 1_500);
  }

  private writeMessage(message: JsonRecord): void {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new Error("Codex App Server 입력 스트림을 사용할 수 없습니다.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  private handleStdoutLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.handleProcessFailure(
        new Error("Codex App Server가 JSON이 아닌 응답을 반환했습니다.", {
          cause: error,
        }),
      );
      return;
    }
    const message = asRecord(parsed);
    if (!message) return;
    if (typeof message.id === "number" && !message.method) {
      this.handleResponse(message.id, message);
      return;
    }
    if (typeof message.method !== "string") return;
    if (message.id !== undefined) {
      this.rejectServerRequest(message);
      return;
    }
    this.publishNotification(message);
  }

  private handleResponse(id: number, message: JsonRecord): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    const rpcError = asRecord(message.error);
    if (!rpcError) {
      pending.resolve(message.result);
      return;
    }
    const detail =
      typeof rpcError.message === "string" ? rpcError.message : "unknown error";
    pending.reject(
      new Error(`Codex App Server ${pending.method} 요청 실패: ${detail}`),
    );
  }

  private rejectServerRequest(message: JsonRecord): void {
    const method = String(message.method);
    if (isCurrentApprovalRequest(method)) {
      this.writeMessage({ id: message.id, result: { decision: "decline" } });
      return;
    }
    if (isLegacyApprovalRequest(method)) {
      this.writeMessage({
        id: message.id,
        result: {
          decision: {
            denied: {
              rejection: "This client does not permit tool execution.",
            },
          },
        },
      });
      return;
    }
    this.writeMessage({
      id: message.id,
      error: { code: -32601, message: "Client method is not available." },
    });
  }

  private publishNotification(notification: JsonRecord): void {
    this.recentNotifications.push(notification);
    if (this.recentNotifications.length > MAX_RECENT_NOTIFICATIONS) {
      this.recentNotifications.shift();
    }
    for (const listener of this.listeners) listener(notification);
  }

  private captureStderr(chunk: string): void {
    for (const rawLine of chunk.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line) continue;
      this.recentStderr.push(line.slice(0, MAX_STDERR_LINE_LENGTH));
      if (this.recentStderr.length > MAX_STDERR_LINES) {
        this.recentStderr.shift();
      }
    }
  }

  private handleProcessFailure(reason: unknown): void {
    if (this.exitError) return;
    const cause = normalizeError(reason);
    this.exitError = new Error(cause.message, { cause });
    Object.assign(this.exitError, {
      recentStderr: this.recentStderr.join("\n"),
      codexVersion: this.version,
    });
    this.rejectPending(this.exitError);
    this.rejectWaiters(this.exitError);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private rejectWaiters(error: Error): void {
    for (const listener of [...this.failureListeners]) listener(error);
    this.failureListeners.clear();
  }
}

function isCurrentApprovalRequest(method: string): boolean {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  );
}

function isLegacyApprovalRequest(method: string): boolean {
  return method === "applyPatchApproval" || method === "execCommandApproval";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function waitForProcessExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(child.exitCode !== null);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}
