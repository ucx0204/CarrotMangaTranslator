/* eslint-disable max-lines -- worker protocol, lifecycle state, spawn diagnostics, and stderr tail stay co-located for auditability */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createChildExitReceipt,
  forceTerminateChildProcessTree,
  shouldSpawnInOwnProcessGroup,
  type ChildExitResult,
} from "./processTreeTermination";

const DEFAULT_WORKER_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
export const JSON_WORKER_SHUTDOWN_GRACE_MS = 1_500;
const MAX_RESPONSE_LINE_LENGTH = 1024 * 1024;
const MAX_STDERR_CHUNK_LENGTH = 16_000;

export type JsonLinesWorkerResponse = {
  id: string;
  ok: boolean;
  error?: string | null;
  elapsed_ms?: unknown;
};

type JsonLinesWorkerClientOptions = {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  workerName: string;
  requestTimeoutMs?: number;
  buildExitError: (code: number | null, stderr: string) => Error;
  buildNotRunningError: (stderr: string) => Error;
  sanitizeStderr: (text: string) => string;
  onStderr: (text: string) => void;
  onSpawn?: (pid: number | null) => void;
  onTerminationError: (error: Error) => void;
  /** @internal Deterministic lifecycle seam used by protocol unit tests. */
  runtime?: Partial<JsonLinesWorkerClientRuntime>;
};

type SpawnWorkerOptions = Pick<
  JsonLinesWorkerClientOptions,
  "executable" | "args" | "env"
>;

type JsonLinesWorkerClientRuntime = {
  spawnWorker: (options: SpawnWorkerOptions) => ChildProcessWithoutNullStreams;
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => unknown;
  clearScheduled: (timer: unknown) => void;
  forceTerminateProcessTree: (
    child: ChildProcessWithoutNullStreams,
  ) => Promise<void>;
  shutdownGraceMs: number;
};

type PendingRequest<TResponse extends JsonLinesWorkerResponse> = {
  id: string;
  startedAt: number;
  deadlineTimer: unknown;
  removeAbortListener: () => void;
  resolve: (response: TResponse) => void;
  reject: (error: Error) => void;
};

type JsonLinesRequestHandle<TResponse extends JsonLinesWorkerResponse> = {
  id: string;
  response: Promise<TResponse>;
};

type WorkerClientState =
  | "running"
  | "closing"
  | "closed"
  | "termination-failed";

type PermanentFailurePlan = {
  primaryRequestId: string | null;
  primaryError: Error;
  otherError: Error;
};

type GracefulShutdownOutcome =
  | { kind: "exited" }
  | { kind: "write-error"; error: Error }
  | { kind: "timeout" };

export class JsonWorkerRequestTimeoutError extends Error {
  readonly code = "JSON_WORKER_REQUEST_TIMEOUT";

  constructor(
    readonly workerName: string,
    readonly requestId: string,
    readonly timeoutMs: number,
    readonly elapsedMs: number,
  ) {
    super(
      `${workerName} 요청 ${requestId}의 절대 응답 제한 ${timeoutMs}ms를 초과했습니다.`,
    );
    this.name = "JsonWorkerRequestTimeoutError";
  }
}

export class JsonLinesWorkerClient<
  TRequest extends object,
  TResponse extends JsonLinesWorkerResponse = JsonLinesWorkerResponse,
> {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly childExitReceipt: ReturnType<typeof createChildExitReceipt>;
  private readonly pending = new Map<string, PendingRequest<TResponse>>();
  private readonly stderrTail: string[] = [];
  private readonly requestTimeoutMs: number;
  private readonly runtime: JsonLinesWorkerClientRuntime;
  private nextId = 1;
  private stdoutBuffer = "";
  private writeQueue: Promise<void> = Promise.resolve();
  private state: WorkerClientState = "running";
  private terminationPromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;

  constructor(private readonly options: JsonLinesWorkerClientOptions) {
    this.requestTimeoutMs = normalizeRequestTimeout(
      options.requestTimeoutMs ?? DEFAULT_WORKER_REQUEST_TIMEOUT_MS,
    );
    this.runtime = resolveClientRuntime(options.runtime);
    this.child = this.runtime.spawnWorker(options);
    this.childExitReceipt = createChildExitReceipt(this.child);
    options.onSpawn?.(this.child.pid ?? null);
    this.child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) =>
      this.rememberStderr(chunk.toString("utf8")),
    );
    this.child.on("error", (error) => this.handleChildError(error));
    this.child.on("exit", (code) => this.handleExit(code));
  }

  startRequest(
    payload: TRequest,
    signal?: AbortSignal,
  ): JsonLinesRequestHandle<TResponse> {
    throwIfAborted(signal);
    this.assertRunning();
    const id = String(this.nextId++);
    const response = new Promise<TResponse>((resolve, reject) => {
      this.registerPendingRequest(id, signal, resolve, reject);
      this.enqueueWrite(`${JSON.stringify({ ...payload, id })}\n`);
    });
    return { id, response };
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeInternal();
    return this.disposePromise;
  }

  isHealthy(): boolean {
    return (
      this.state === "running" &&
      this.child.exitCode === null &&
      this.child.signalCode === null &&
      this.child.stdin.writable
    );
  }

  getStderr(): string {
    return this.stderrTail.join("");
  }

  private async disposeInternal(): Promise<void> {
    if (this.terminationPromise) {
      await this.terminationPromise;
      return;
    }
    if (this.state === "closed") {
      return;
    }
    if (this.state === "termination-failed") {
      throw new Error(
        `${this.options.workerName} 워커 종료가 이미 실패했습니다.`,
      );
    }
    if (this.pending.size > 0) {
      const error = new Error(
        `${this.options.workerName} 워커가 종료되었습니다.`,
      );
      await this.beginPermanentFailure({
        primaryRequestId: null,
        primaryError: error,
        otherError: error,
      });
      return;
    }

    this.state = "closing";
    if (this.childExitReceipt.hasExited()) {
      this.state = "closed";
      return;
    }

    const shutdownWrite = this.beginGracefulShutdown();
    const outcome = await waitForGracefulShutdown(
      this.childExitReceipt.promise,
      shutdownWrite,
      this.runtime.shutdownGraceMs,
      this.runtime,
    );
    if (outcome.kind === "exited") {
      this.state = "closed";
      return;
    }

    try {
      await this.runtime.forceTerminateProcessTree(this.child);
      this.state = "closed";
    } catch (error) {
      const terminationError = toError(error);
      this.state = "termination-failed";
      this.options.onTerminationError(terminationError);
      throw terminationError;
    }
  }

  private registerPendingRequest(
    id: string,
    signal: AbortSignal | undefined,
    resolve: (response: TResponse) => void,
    reject: (error: Error) => void,
  ): void {
    const startedAt = this.runtime.now();
    const onAbort = () => this.abortRequest(id);
    const removeAbortListener = () =>
      signal?.removeEventListener("abort", onAbort);
    const deadlineTimer = this.runtime.schedule(
      () => this.handleRequestTimeout(id, startedAt),
      this.requestTimeoutMs,
    );

    this.pending.set(id, {
      id,
      startedAt,
      deadlineTimer,
      removeAbortListener,
      resolve,
      reject,
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  }

  private abortRequest(id: string): void {
    if (!this.pending.has(id)) {
      return;
    }
    void this.beginPermanentFailure({
      primaryRequestId: id,
      primaryError: createAbortError(),
      otherError: new Error(
        `${this.options.workerName} 워커가 다른 요청의 취소로 종료되었습니다.`,
      ),
    });
  }

  private enqueueWrite(line: string): void {
    const write = this.writeQueue.then(() => this.writeLine(line));
    this.writeQueue = write.then(
      () => undefined,
      (error) => {
        const failure = toError(error);
        void this.beginPermanentFailure({
          primaryRequestId: null,
          primaryError: failure,
          otherError: failure,
        });
      },
    );
  }

  private writeLine(line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.state !== "running" || !this.child.stdin.writable) {
        reject(this.options.buildNotRunningError(this.getStderr()));
        return;
      }
      try {
        this.child.stdin.write(line, "utf8", (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      } catch (error) {
        reject(toError(error));
      }
    });
  }

  private beginGracefulShutdown(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.child.stdin.writable) {
        resolve();
        return;
      }
      try {
        this.child.stdin.write(
          `${JSON.stringify({ type: "shutdown" })}\n`,
          "utf8",
          (error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          },
        );
        this.child.stdin.end();
      } catch (error) {
        reject(toError(error));
      }
    });
  }

  private handleStdout(chunk: Buffer): void {
    if (this.state !== "running") {
      return;
    }
    this.stdoutBuffer += chunk.toString("utf8");
    while (this.state === "running") {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        if (this.stdoutBuffer.length > MAX_RESPONSE_LINE_LENGTH) {
          this.failProtocol(
            `응답 한 줄이 최대 길이 ${MAX_RESPONSE_LINE_LENGTH}자를 초과했습니다.`,
          );
        }
        return;
      }
      if (newlineIndex > MAX_RESPONSE_LINE_LENGTH) {
        this.failProtocol(
          `응답 한 줄이 최대 길이 ${MAX_RESPONSE_LINE_LENGTH}자를 초과했습니다.`,
        );
        return;
      }
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line && !this.handleResponseLine(line)) {
        return;
      }
    }
  }

  private handleResponseLine(line: string): boolean {
    const stripped = stripAnsiEscapes(line);
    if (!stripped.startsWith("{")) {
      this.rememberStderr(`${line}\n`);
      return true;
    }
    const parsed = parseResponseLine(stripped);
    if (!parsed.ok) {
      this.failProtocol(parsed.detail);
      return false;
    }
    const response = parsed.response;
    const pending = this.takePending(response.id);
    if (!pending) {
      this.failProtocol(`알 수 없는 요청 ID를 받았습니다: ${response.id}`);
      return false;
    }
    pending.resolve(response as TResponse);
    return true;
  }

  private handleExit(code: number | null): void {
    if (this.terminationPromise) {
      return;
    }
    if (this.state === "running") {
      this.state = "closed";
      this.rejectAllNow(this.options.buildExitError(code, this.getStderr()));
      return;
    }
    if (this.state === "closing") {
      this.state = "closed";
    }
  }

  private handleChildError(error: Error): void {
    if (this.state !== "running") {
      return;
    }
    const failure = this.enrichSpawnError(error);
    void this.beginPermanentFailure({
      primaryRequestId: null,
      primaryError: failure,
      otherError: failure,
    });
  }

  private handleRequestTimeout(id: string, startedAt: number): void {
    if (!this.pending.has(id)) {
      return;
    }
    const timeoutError = new JsonWorkerRequestTimeoutError(
      this.options.workerName,
      id,
      this.requestTimeoutMs,
      Math.max(0, this.runtime.now() - startedAt),
    );
    void this.beginPermanentFailure({
      primaryRequestId: id,
      primaryError: timeoutError,
      otherError: new Error(
        `${this.options.workerName} 워커가 요청 ${id} timeout 때문에 종료되었습니다.`,
      ),
    });
  }

  private failProtocol(detail: string): void {
    const error = new Error(
      `${this.options.workerName} 응답 프로토콜 오류: ${detail}`,
    );
    void this.beginPermanentFailure({
      primaryRequestId: null,
      primaryError: error,
      otherError: error,
    });
  }

  private beginPermanentFailure(plan: PermanentFailurePlan): Promise<void> {
    if (this.terminationPromise) {
      return this.terminationPromise;
    }
    if (this.state === "closed") {
      this.rejectPendingFromPlan(plan, null);
      return Promise.resolve();
    }

    this.state = "closing";
    this.cancelAllPendingWatchdogs();
    this.terminationPromise = this.terminateAndReject(plan);
    void this.terminationPromise.catch((error) =>
      this.options.onTerminationError(toError(error)),
    );
    return this.terminationPromise;
  }

  private async terminateAndReject(plan: PermanentFailurePlan): Promise<void> {
    let terminationError: Error | null = null;
    try {
      await this.runtime.forceTerminateProcessTree(this.child);
      this.state = "closed";
    } catch (error) {
      terminationError = toError(error);
      this.state = "termination-failed";
    } finally {
      this.rejectPendingFromPlan(plan, terminationError);
    }

    if (terminationError) {
      throw terminationError;
    }
  }

  private rejectPendingFromPlan(
    plan: PermanentFailurePlan,
    terminationError: Error | null,
  ): void {
    for (const id of [...this.pending.keys()]) {
      const pending = this.takePending(id);
      if (!pending) {
        continue;
      }
      const error =
        id === plan.primaryRequestId ? plan.primaryError : plan.otherError;
      if (terminationError) {
        Object.assign(error, { terminationError });
      }
      pending.reject(error);
    }
  }

  private takePending(id: string): PendingRequest<TResponse> | null {
    const pending = this.pending.get(id);
    if (!pending) {
      return null;
    }
    this.pending.delete(id);
    this.runtime.clearScheduled(pending.deadlineTimer);
    pending.removeAbortListener();
    return pending;
  }

  private cancelAllPendingWatchdogs(): void {
    for (const pending of this.pending.values()) {
      this.runtime.clearScheduled(pending.deadlineTimer);
      pending.removeAbortListener();
    }
  }

  private rejectAllNow(error: Error): void {
    for (const id of [...this.pending.keys()]) {
      this.takePending(id)?.reject(error);
    }
  }

  /**
   * spawn UNKNOWN 등 child "error" 이벤트는 buildExitError(큐레이션된 백엔드별
   * 메시지)를 거치지 않고 Node의 raw Error를 그대로 reject한다. 실행 파일 경로와
   * 인자, 조치 힌트를 덧붙여 사용자가 백신 차단/누락된 DLL/PATH 문제를 진단할
   * 수 있게 한다. code/errno는 보존한다.
   */
  private enrichSpawnError(error: Error): Error {
    const code = (error as { code?: unknown }).code;
    const detail =
      typeof code === "string" ? code : error.message || "spawn error";
    const enriched = new Error(
      `${this.options.workerName} 실행 파일을 시작하지 못했습니다 (${detail}): ${this.options.executable} ${this.options.args.join(" ")}. 백신 차단, 누락된 DLL, 또는 PATH를 확인하세요. ${this.getStderr()}`.trim(),
    );
    return Object.assign(enriched, {
      code: (error as { code?: unknown }).code,
      errno: (error as { errno?: unknown }).errno,
    });
  }

  private assertRunning(): void {
    if (!this.isHealthy()) {
      throw this.options.buildNotRunningError(this.getStderr());
    }
  }

  private rememberStderr(text: string): void {
    const sanitized = this.options
      .sanitizeStderr(text)
      .slice(-MAX_STDERR_CHUNK_LENGTH);
    this.stderrTail.push(sanitized);
    if (this.stderrTail.length > 80) {
      this.stderrTail.splice(0, this.stderrTail.length - 80);
    }
    this.options.onStderr(sanitized);
  }
}

async function waitForGracefulShutdown(
  exitPromise: Promise<ChildExitResult>,
  shutdownWrite: Promise<void>,
  timeoutMs: number,
  scheduler: Pick<JsonLinesWorkerClientRuntime, "schedule" | "clearScheduled">,
): Promise<GracefulShutdownOutcome> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: GracefulShutdownOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      scheduler.clearScheduled(timeout);
      resolve(outcome);
    };
    const timeout = scheduler.schedule(
      () => finish({ kind: "timeout" }),
      timeoutMs,
    );
    void exitPromise.then(() => finish({ kind: "exited" }));
    void shutdownWrite.catch((error) =>
      finish({ kind: "write-error", error: toError(error) }),
    );
  });
}

type ParsedResponse =
  | { ok: true; response: JsonLinesWorkerResponse }
  | { ok: false; detail: string };

function stripAnsiEscapes(line: string): string {
  return line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function parseResponseLine(line: string): ParsedResponse {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return {
      ok: false,
      detail: `JSON을 해석할 수 없습니다 (${formatInvalidLine(line)}): ${toError(error).message}`,
    };
  }
  if (!isResponseRecord(value)) {
    return {
      ok: false,
      detail: `id와 ok가 올바르지 않습니다 (${formatInvalidLine(line)})`,
    };
  }
  return { ok: true, response: value };
}

function isResponseRecord(value: unknown): value is JsonLinesWorkerResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.ok === "boolean" &&
    (candidate.error == null || typeof candidate.error === "string")
  );
}

function formatInvalidLine(line: string): string {
  return JSON.stringify(line.slice(0, 240));
}

function normalizeRequestTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("워커 요청 timeout은 0보다 큰 유한한 값이어야 합니다.");
  }
  return Math.max(1, Math.floor(timeoutMs));
}

function resolveClientRuntime(
  overrides: Partial<JsonLinesWorkerClientRuntime> | undefined,
): JsonLinesWorkerClientRuntime {
  const runtime = { ...defaultClientRuntime, ...overrides };
  return {
    ...runtime,
    shutdownGraceMs: normalizeShutdownGrace(runtime.shutdownGraceMs),
  };
}

const defaultClientRuntime: JsonLinesWorkerClientRuntime = {
  spawnWorker: ({ executable, args, env }) =>
    spawn(executable, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env,
      detached: shouldSpawnInOwnProcessGroup(),
    }),
  now: () => Date.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  clearScheduled: (timer) =>
    clearTimeout(timer as ReturnType<typeof setTimeout>),
  forceTerminateProcessTree: async (child) => {
    await forceTerminateChildProcessTree(child);
  },
  shutdownGraceMs: JSON_WORKER_SHUTDOWN_GRACE_MS,
};

function normalizeShutdownGrace(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("워커 종료 grace는 0보다 큰 유한한 값이어야 합니다.");
  }
  return Math.max(1, Math.floor(timeoutMs));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function createAbortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
