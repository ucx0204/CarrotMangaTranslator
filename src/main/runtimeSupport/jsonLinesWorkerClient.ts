/* eslint-disable max-lines -- worker protocol, spawn diagnostics, and stderr tail stay co-located for auditability */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const DEFAULT_WORKER_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
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
};

type PendingRequest<TResponse extends JsonLinesWorkerResponse> = {
  resolve: (response: TResponse) => void;
  reject: (error: Error) => void;
  refreshTimeout: () => void;
};

type JsonLinesRequestHandle<TResponse extends JsonLinesWorkerResponse> = {
  id: string;
  response: Promise<TResponse>;
};

export class JsonLinesWorkerClient<
  TRequest extends object,
  TResponse extends JsonLinesWorkerResponse = JsonLinesWorkerResponse,
> {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest<TResponse>>();
  private readonly stderrTail: string[] = [];
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  private stdoutBuffer = "";
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: JsonLinesWorkerClientOptions) {
    this.requestTimeoutMs = normalizeRequestTimeout(
      options.requestTimeoutMs ?? DEFAULT_WORKER_REQUEST_TIMEOUT_MS,
    );
    this.child = spawn(options.executable, options.args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env,
    });
    options.onSpawn?.(this.child.pid ?? null);
    this.child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) =>
      this.rememberStderr(chunk.toString("utf8")),
    );
    this.child.on("error", (error) =>
      this.failPermanently(this.enrichSpawnError(error)),
    );
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

  async dispose(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.pending.size > 0) {
      this.failPermanently(
        new Error(`${this.options.workerName} 워커가 종료되었습니다.`),
      );
      return;
    }
    try {
      if (this.child.stdin.writable) {
        this.child.stdin.write(
          `${JSON.stringify({ type: "shutdown" })}\n`,
          "utf8",
          (error) => {
            if (error) {
              this.failPermanently(error);
            }
          },
        );
        this.child.stdin.end();
      }
      await this.waitForExit(1500);
    } catch (error) {
      this.failPermanently(toError(error));
    } finally {
      if (!this.closed) {
        this.killChild();
        this.closed = true;
        this.rejectAll(
          new Error(`${this.options.workerName} 워커가 종료되었습니다.`),
        );
      }
    }
  }

  isHealthy(): boolean {
    return (
      !this.closed &&
      this.child.exitCode === null &&
      this.child.signalCode === null &&
      this.child.stdin.writable
    );
  }

  getStderr(): string {
    return this.stderrTail.join("");
  }

  private registerPendingRequest(
    id: string,
    signal: AbortSignal | undefined,
    resolve: (response: TResponse) => void,
    reject: (error: Error) => void,
  ): void {
    const onAbort = () => this.abortRequest(id);
    let timeout: ReturnType<typeof setTimeout>;
    const refreshTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(
        () => this.handleRequestTimeout(id),
        this.requestTimeoutMs,
      );
    };
    const removeAbortListener = () =>
      signal?.removeEventListener("abort", onAbort);
    this.pending.set(id, {
      resolve: (response) => {
        clearTimeout(timeout);
        removeAbortListener();
        resolve(response);
      },
      reject: (error) => {
        clearTimeout(timeout);
        removeAbortListener();
        reject(error);
      },
      refreshTimeout,
    });
    refreshTimeout();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  }

  private abortRequest(id: string): void {
    const aborted = this.pending.get(id);
    if (!aborted) {
      return;
    }
    if (!this.closed) {
      this.closed = true;
      this.killChild();
    }
    this.pending.delete(id);
    aborted.reject(createAbortError());
    this.rejectAll(
      new Error(
        `${this.options.workerName} 워커가 다른 요청의 취소로 종료되었습니다.`,
      ),
    );
  }

  private enqueueWrite(line: string): void {
    const write = this.writeQueue.then(() => this.writeLine(line));
    this.writeQueue = write.then(
      () => undefined,
      (error) => this.failPermanently(toError(error)),
    );
  }

  private writeLine(line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed || !this.child.stdin.writable) {
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

  private handleStdout(chunk: Buffer): void {
    this.refreshPendingRequestTimeouts();
    this.stdoutBuffer += chunk.toString("utf8");
    while (!this.closed) {
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
    // Flux/Koharu/anime-text 런타임이 CUDA/드라이버 경고(ANSI 이스케이프 포함)를
    // stdout에 섞어 내보낼 수 있다. 이전에는 비-JSON 라인 한 줄이 프로토콜
    // 오류로 워커를 kill했는데, 노이즈는 스킵하고 진단용 stderr tail에만
    // 보관한다. { 로 시작하는 라인만 응답 후보로 파싱한다.
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
    const pending = this.pending.get(response.id);
    if (!pending) {
      this.failProtocol(`알 수 없는 요청 ID를 받았습니다: ${response.id}`);
      return false;
    }
    this.pending.delete(response.id);
    pending.resolve(response as TResponse);
    return true;
  }

  private handleExit(code: number | null): void {
    this.closed = true;
    if (this.pending.size > 0) {
      this.rejectAll(this.options.buildExitError(code, this.getStderr()));
    }
  }

  private handleRequestTimeout(id: string): void {
    if (!this.pending.has(id)) {
      return;
    }
    this.failPermanently(
      new Error(
        `${this.options.workerName} 요청 ${id}의 응답 시간이 ${this.requestTimeoutMs}ms를 초과했습니다.`,
      ),
    );
  }

  private failProtocol(detail: string): void {
    this.failPermanently(
      new Error(`${this.options.workerName} 응답 프로토콜 오류: ${detail}`),
    );
  }

  private failPermanently(error: Error): void {
    if (!this.closed) {
      this.closed = true;
      this.killChild();
    }
    this.rejectAll(error);
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

  private killChild(): void {
    if (
      this.child.pid !== undefined &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    ) {
      this.child.kill("SIGTERM");
    }
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    if (
      this.child.exitCode !== null ||
      this.child.signalCode !== null ||
      this.closed
    ) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timeout);
        this.child.removeListener("exit", finish);
        this.child.removeListener("error", finish);
        resolve();
      };
      const timeout = setTimeout(finish, timeoutMs);
      this.child.once("exit", finish);
      this.child.once("error", finish);
    });
  }

  private rememberStderr(text: string): void {
    this.refreshPendingRequestTimeouts();
    const sanitized = this.options
      .sanitizeStderr(text)
      .slice(-MAX_STDERR_CHUNK_LENGTH);
    this.stderrTail.push(sanitized);
    if (this.stderrTail.length > 80) {
      this.stderrTail.splice(0, this.stderrTail.length - 80);
    }
    this.options.onStderr(sanitized);
  }

  private refreshPendingRequestTimeouts(): void {
    for (const pending of this.pending.values()) {
      pending.refreshTimeout();
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
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
