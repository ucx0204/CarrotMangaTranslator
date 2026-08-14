import { describe, expect, it, vi } from "vitest";
import {
  ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { TransformCallback } from "node:stream";
import {
  JSON_WORKER_SHUTDOWN_GRACE_MS,
  JsonLinesWorkerClient,
  JsonWorkerRequestTimeoutError,
} from "../src/main/runtimeSupport/jsonLinesWorkerClient";

const NOISE_THEN_RESPONSE_SCRIPT = `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let req;
    try { req = JSON.parse(line); } catch (e) { continue; }
    if (req.type === "shutdown") process.exit(0);
    process.stdout.write("\\u001b[31m[CUDA] no-op driver warning\\u001b[0m noise\\n");
    process.stdout.write(JSON.stringify({ id: req.id, ok: true }) + "\\n");
  }
});
`;

const IGNORE_SHUTDOWN_SCRIPT = `
setInterval(() => {}, 1000);
process.stdin.resume();
`;

function noisyHangScript(stream: "stdout" | "stderr"): string {
  return `
let buf = "";
let noiseTimer = null;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const req = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (req.type === "start_noise") {
      noiseTimer ??= setInterval(() => {
        process.${stream}.write("global worker noise\\n");
      }, 10);
      process.stdout.write(JSON.stringify({ id: req.id, ok: true }) + "\\n");
    } else if (req.type === "shutdown") {
      clearInterval(noiseTimer);
      process.exit(0);
    }
  }
});
`;
}

function makeWorkerDir(script: string): { dir: string; scriptPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "jlwc-"));
  const scriptPath = join(dir, "worker.js");
  writeFileSync(scriptPath, script);
  return { dir, scriptPath };
}

type MakeClientOptions = {
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
  onSpawn?: (pid: number | null) => void;
  onTerminationError?: (error: Error) => void;
};

function makeClient(scriptPath: string, options: MakeClientOptions = {}) {
  return new JsonLinesWorkerClient<{ type: string }>({
    executable: process.execPath,
    args: [scriptPath],
    env: process.env,
    workerName: "Test 워커",
    requestTimeoutMs: options.requestTimeoutMs ?? 5000,
    buildExitError: (code, stderr) => new Error(`exit ${code} ${stderr}`),
    buildNotRunningError: (stderr) => new Error(`not running ${stderr}`),
    sanitizeStderr: (text) => text,
    onStderr: () => {},
    onSpawn: options.onSpawn,
    onTerminationError: options.onTerminationError ?? (() => {}),
    runtime:
      options.shutdownGraceMs === undefined
        ? undefined
        : { shutdownGraceMs: options.shutdownGraceMs },
  });
}

type FakeWorkerControl = {
  sendStdout: (text: string | Buffer) => void;
  sendStderr: (text: string) => void;
};

type FakeWorkerOptions = {
  exitOnShutdown?: boolean;
  initialExitCode?: number;
  shutdownWriteError?: Error;
  onRequest?: (
    request: Record<string, unknown>,
    control: FakeWorkerControl,
  ) => void;
};

class FakeWorkerInput extends PassThrough {
  constructor(private readonly shutdownWriteError: Error | undefined) {
    super();
    this.on("error", () => undefined);
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    if (
      this.shutdownWriteError &&
      chunk.toString("utf8").includes('"type":"shutdown"')
    ) {
      callback(this.shutdownWriteError);
      return;
    }
    callback(null, chunk);
  }
}

function createFakeWorker(options: FakeWorkerOptions = {}) {
  const stdin = new FakeWorkerInput(options.shutdownWriteError);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const processFields: {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
  } = {
    stdin,
    stdout,
    stderr,
    pid: 42_424,
    exitCode: options.initialExitCode ?? null,
    signalCode: null,
    kill: vi.fn(() => true),
  };
  const fakeChild = Object.assign(new ChildProcess(), processFields);
  const child = fakeChild as ChildProcessWithoutNullStreams;
  let inputBuffer = "";
  let shutdownWrites = 0;

  const exit = (
    code: number | null = 0,
    signal: NodeJS.Signals | null = null,
  ) => {
    if (fakeChild.exitCode !== null || fakeChild.signalCode !== null) {
      return;
    }
    fakeChild.exitCode = code;
    fakeChild.signalCode = signal;
    child.emit("exit", code, signal);
    child.emit("close", code, signal);
  };
  const control: FakeWorkerControl = {
    sendStdout: (text) => stdout.write(text),
    sendStderr: (text) => stderr.write(text),
  };

  stdin.setEncoding("utf8");
  stdin.on("data", (chunk) => {
    inputBuffer += String(chunk);
    let newlineIndex = inputBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = inputBuffer.slice(0, newlineIndex);
      inputBuffer = inputBuffer.slice(newlineIndex + 1);
      const request = JSON.parse(line) as Record<string, unknown>;
      if (request.type === "shutdown") {
        shutdownWrites += 1;
        if (options.exitOnShutdown ?? true) {
          exit();
        }
      } else {
        options.onRequest?.(request, control);
      }
      newlineIndex = inputBuffer.indexOf("\n");
    }
  });

  return {
    child,
    exit,
    getShutdownWrites: () => shutdownWrites,
  };
}

function createManualScheduler() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map<
    number,
    { callback: () => void; deadline: number; delayMs: number }
  >();
  const schedule = (callback: () => void, delayMs: number): number => {
    const id = nextId++;
    tasks.set(id, { callback, deadline: now + delayMs, delayMs });
    return id;
  };
  const clearScheduled = (timer: unknown): void => {
    if (typeof timer === "number") {
      tasks.delete(timer);
    }
  };
  const advanceBy = async (durationMs: number): Promise<void> => {
    now += durationMs;
    while (true) {
      const due = [...tasks.entries()]
        .filter(([, task]) => task.deadline <= now)
        .sort((left, right) => left[1].deadline - right[1].deadline)[0];
      if (!due) {
        break;
      }
      tasks.delete(due[0]);
      due[1].callback();
      await Promise.resolve();
    }
    await Promise.resolve();
  };
  return {
    now: () => now,
    schedule,
    clearScheduled,
    advanceBy,
    pendingCount: () => tasks.size,
    scheduledDelays: () => [...tasks.values()].map((task) => task.delayMs),
  };
}

type FakeClientOptions = FakeWorkerOptions & {
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
  terminationGate?: Promise<void>;
  terminationError?: Error;
  onTerminationError?: (error: Error) => void;
};

function makeFakeClient(options: FakeClientOptions = {}) {
  const worker = createFakeWorker(options);
  const scheduler = createManualScheduler();
  const forceTerminate = vi.fn(async () => {
    await options.terminationGate;
    if (options.terminationError) {
      throw options.terminationError;
    }
    worker.exit(null, "SIGKILL");
  });
  const spawnWorker = vi.fn(() => worker.child);
  const client = new JsonLinesWorkerClient<{ type: string }>({
    executable: "fake-worker",
    args: [],
    env: {},
    workerName: "Test 워커",
    requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
    buildExitError: (code, stderr) => new Error(`exit ${code} ${stderr}`),
    buildNotRunningError: (stderr) => new Error(`not running ${stderr}`),
    sanitizeStderr: (text) => text,
    onStderr: () => {},
    onTerminationError: options.onTerminationError ?? (() => {}),
    runtime: {
      spawnWorker,
      now: scheduler.now,
      schedule: scheduler.schedule,
      clearScheduled: scheduler.clearScheduled,
      forceTerminateProcessTree: forceTerminate,
      ...(options.shutdownGraceMs === undefined
        ? {}
        : { shutdownGraceMs: options.shutdownGraceMs }),
    },
  });
  return { client, forceTerminate, scheduler, spawnWorker, worker };
}

describe("JsonLinesWorkerClient", () => {
  it("survives non-JSON stdout noise (CUDA warnings with ANSI) and still resolves the response", async () => {
    const { dir, scriptPath } = makeWorkerDir(NOISE_THEN_RESPONSE_SCRIPT);
    const client = makeClient(scriptPath);
    try {
      const handle = client.startRequest({ type: "ping" });
      const response = await handle.response;
      expect(response.ok).toBe(true);
      expect(response.id).toBe(handle.id);
    } finally {
      try {
        await client.dispose();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("fails the protocol when a { -prefixed line is malformed JSON", async () => {
    const { client } = makeFakeClient({
      onRequest: (_request, control) => control.sendStdout("{bad json\n"),
    });
    const handle = client.startRequest({ type: "ping" });
    await expect(handle.response).rejects.toThrow(/응답 프로토콜 오류/);
    expect(client.isHealthy()).toBe(false);
    await client.dispose();
  });

  it.each([
    [JSON.stringify({ ok: true }) + "\n", /id와 ok가 올바르지 않습니다/],
    [
      JSON.stringify({ id: "unknown-request", ok: true }) + "\n",
      /알 수 없는 요청 ID.*unknown-request/,
    ],
    [
      "x".repeat(1024 * 1024 + 1),
      /응답 한 줄이 최대 길이 1048576자를 초과했습니다/,
    ],
    [
      `${"x".repeat(1024 * 1024 + 1)}\n`,
      /응답 한 줄이 최대 길이 1048576자를 초과했습니다/,
    ],
    [
      `${JSON.stringify({ id: "1", ok: true, error: 7 })}\n`,
      /id와 ok가 올바르지 않습니다/,
    ],
  ])(
    "fails closed for an invalid response envelope",
    async (responseLine, message) => {
      const { client } = makeFakeClient({
        onRequest: (_request, control) =>
          control.sendStdout(responseLine as string),
      });
      const handle = client.startRequest({ type: "ping" });
      await expect(handle.response).rejects.toThrow(message);
      expect(client.isHealthy()).toBe(false);
      await client.dispose();
    },
  );

  it("surfaces the executable path and hint when spawn fails without reporting a termination failure", async () => {
    const onTerminationError = vi.fn();
    const client = new JsonLinesWorkerClient<{ type: string }>({
      executable: "/does/not/exist/mgt-flux-klein.exe",
      args: ["--cuda-runtime-dir", "/missing"],
      env: process.env,
      workerName: "Flux 인페인팅 런타임",
      buildExitError: (code, stderr) => new Error(`exit ${code} ${stderr}`),
      buildNotRunningError: (stderr) => new Error(`not running ${stderr}`),
      sanitizeStderr: (text) => text,
      onStderr: () => {},
      onTerminationError,
    });
    try {
      const handle = client.startRequest({ type: "ping" });
      await expect(withHardCap(handle.response)).rejects.toThrow(
        /실행 파일을 시작하지 못했습니다.*\/does\/not\/exist\/mgt-flux-klein\.exe/,
      );
      expect(onTerminationError).not.toHaveBeenCalled();
    } finally {
      await withHardCap(client.dispose());
    }
  });

  it("does not let stdout noise extend an absolute request deadline", async () => {
    await expectNoiseDoesNotExtendDeadline("stdout");
  });

  it("does not let stderr noise extend an absolute request deadline", async () => {
    await expectNoiseDoesNotExtendDeadline("stderr");
  });

  it("cleans the deadline timer after a successful response", async () => {
    const { client, scheduler } = makeFakeClient({
      requestTimeoutMs: 1_000,
      onRequest: (request, control) =>
        control.sendStdout(`${JSON.stringify({ id: request.id, ok: true })}\n`),
    });
    await expect(
      client.startRequest({ type: "ping" }).response,
    ).resolves.toMatchObject({ ok: true });
    expect(scheduler.pendingCount()).toBe(0);
    await scheduler.advanceBy(1_200);
    expect(client.isHealthy()).toBe(true);
    await client.dispose();
  });

  it("keeps AbortError only on the request that initiated worker termination", async () => {
    const { client } = makeFakeClient();
    const controller = new AbortController();
    const primary = client.startRequest({ type: "hang" }, controller.signal);
    const other = client.startRequest({ type: "hang" });
    const settledPromise = Promise.allSettled([
      primary.response,
      other.response,
    ]);
    controller.abort();
    const [primaryResult, otherResult] = await settledPromise;

    expect(primaryResult.status).toBe("rejected");
    expect(otherResult.status).toBe("rejected");
    if (primaryResult.status === "rejected") {
      expect(primaryResult.reason).toMatchObject({ name: "AbortError" });
    }
    if (otherResult.status === "rejected") {
      expect(otherResult.reason).not.toMatchObject({ name: "AbortError" });
      expect(String(otherResult.reason)).toContain("다른 요청의 취소");
    }
    expect(client.isHealthy()).toBe(false);
    await client.dispose();
  });

  it("coalesces concurrent dispose calls into one promise", async () => {
    const { client, worker } = makeFakeClient();
    const first = client.dispose();
    const second = client.dispose();
    expect(first).toBe(second);
    await first;
    expect(worker.getShutdownWrites()).toBe(1);
    expect(client.isHealthy()).toBe(false);
    expect(() => client.startRequest({ type: "ping" })).toThrow(/not running/);
  });

  it("rejects invalid timeout configuration before spawning", () => {
    const { child } = createFakeWorker();
    const spawnWorker = vi.fn(() => child);
    expect(
      () =>
        new JsonLinesWorkerClient<{ type: string }>({
          executable: "fake-worker",
          args: [],
          env: {},
          workerName: "Test 워커",
          requestTimeoutMs: 0,
          buildExitError: (code) => new Error(`exit ${code}`),
          buildNotRunningError: () => new Error("not running"),
          sanitizeStderr: (text) => text,
          onStderr: () => {},
          onTerminationError: () => {},
          runtime: { spawnWorker },
        }),
    ).toThrow(/timeout은 0보다 큰 유한한 값/);
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("keeps the production 1500ms grace before forcing termination", async () => {
    expect(JSON_WORKER_SHUTDOWN_GRACE_MS).toBe(1_500);
    const { client, forceTerminate, scheduler, worker } = makeFakeClient({
      exitOnShutdown: false,
    });

    const disposal = client.dispose();
    expect(worker.getShutdownWrites()).toBe(1);
    expect(scheduler.scheduledDelays()).toEqual([
      JSON_WORKER_SHUTDOWN_GRACE_MS,
    ]);

    await scheduler.advanceBy(JSON_WORKER_SHUTDOWN_GRACE_MS - 1);
    expect(forceTerminate).not.toHaveBeenCalled();
    await scheduler.advanceBy(1);
    await disposal;
    expect(forceTerminate).toHaveBeenCalledOnce();
  });

  it("rejects an invalid injected shutdown grace before spawning", () => {
    expect(() => makeFakeClient({ shutdownGraceMs: 0 })).toThrow(
      /종료 grace는 0보다 큰 유한한 값/,
    );
  });

  it("preserves protocol and termination faults when forced cleanup fails", async () => {
    const terminationError = new Error("tree termination failed");
    const onTerminationError = vi.fn();
    const { client } = makeFakeClient({
      terminationError,
      onTerminationError,
      onRequest: (_request, control) => control.sendStdout("{bad json\n"),
    });

    const response = client.startRequest({ type: "ping" }).response;
    await expect(response).rejects.toMatchObject({ terminationError });
    expect(onTerminationError).toHaveBeenCalledWith(terminationError);
    await expect(client.dispose()).rejects.toBe(terminationError);
  });

  it("rejects pending work when the transport exits unexpectedly", async () => {
    const { client, worker } = makeFakeClient();
    const response = client.startRequest({ type: "hang" }).response;

    worker.exit(17);

    await expect(response).rejects.toThrow(/exit 17/);
    await client.dispose();
  });

  it("disposes an already-exited transport without shutdown or force", async () => {
    const { client, forceTerminate, worker } = makeFakeClient({
      initialExitCode: 0,
    });

    await client.dispose();

    expect(worker.getShutdownWrites()).toBe(0);
    expect(forceTerminate).not.toHaveBeenCalled();
  });

  it("forces termination immediately when the shutdown write fails", async () => {
    const shutdownWriteError = new Error("shutdown pipe failed");
    const { client, forceTerminate, worker } = makeFakeClient({
      exitOnShutdown: false,
      shutdownWriteError,
    });

    await client.dispose();

    expect(worker.getShutdownWrites()).toBe(0);
    expect(forceTerminate).toHaveBeenCalledOnce();
  });

  it("rejects an already-aborted request before writing to the worker", async () => {
    const { client } = makeFakeClient();
    const controller = new AbortController();
    controller.abort();

    expect(() =>
      client.startRequest({ type: "ping" }, controller.signal),
    ).toThrow(/Aborted/);
    await client.dispose();
  });

  it("bounds the remembered stderr tail to the latest 80 chunks", async () => {
    const { client } = makeFakeClient({
      onRequest: (request, control) => {
        for (let index = 0; index < 81; index += 1) {
          control.sendStderr(`stderr-${index}\n`);
        }
        control.sendStdout(`${JSON.stringify({ id: request.id, ok: true })}\n`);
      },
    });

    await client.startRequest({ type: "ping" }).response;

    expect(client.getStderr()).not.toContain("stderr-0\n");
    expect(client.getStderr()).toContain("stderr-80\n");
    await client.dispose();
  });

  it("enriches child errors that do not expose an errno code", async () => {
    const { client, worker } = makeFakeClient();
    const response = client.startRequest({ type: "hang" }).response;

    worker.child.emit("error", new Error("launch denied"));

    await expect(response).rejects.toThrow(
      /launch denied.*fake-worker.*백신 차단/,
    );
    await client.dispose();
  });

  it("force-terminates a worker that ignores the shutdown message", async () => {
    const { dir, scriptPath } = makeWorkerDir(IGNORE_SHUTDOWN_SCRIPT);
    let pid: number | null = null;
    const client = makeClient(scriptPath, {
      shutdownGraceMs: 20,
      onSpawn: (spawnedPid) => {
        pid = spawnedPid;
      },
    });
    try {
      expect(pid).not.toBeNull();
      await withHardCap(client.dispose(), 6_000);
      expect(client.isHealthy()).toBe(false);
      expect(isProcessAlive(pid)).toBe(false);
    } finally {
      if (pid !== null) {
        cleanupProcess(pid);
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not resolve dispose with a pending request until the child has exited", async () => {
    const termination = createDeferred<void>();
    const { client, forceTerminate, worker } = makeFakeClient({
      terminationGate: termination.promise,
    });
    const handle = client.startRequest({ type: "hang" });
    const disposal = client.dispose();
    let disposalSettled = false;
    void disposal.finally(() => {
      disposalSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(forceTerminate).toHaveBeenCalledOnce();
    expect(disposalSettled).toBe(false);

    termination.resolve(undefined);
    const [requestResult, disposeResult] = await Promise.allSettled([
      handle.response,
      disposal,
    ]);
    expect(requestResult.status).toBe("rejected");
    expect(disposeResult.status).toBe("fulfilled");
    expect(forceTerminate).toHaveBeenCalledOnce();
    expect(worker.child.exitCode ?? worker.child.signalCode).not.toBeNull();
  });
});

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function expectNoiseDoesNotExtendDeadline(
  stream: "stdout" | "stderr",
): Promise<void> {
  const { dir, scriptPath } = makeWorkerDir(noisyHangScript(stream));
  const timeoutMs = 300;
  const client = makeClient(scriptPath, { requestTimeoutMs: timeoutMs });
  try {
    await expect(
      client.startRequest({ type: "start_noise" }).response,
    ).resolves.toMatchObject({ ok: true });
    const hang = client.startRequest({ type: "hang" });
    let rejection: unknown;
    try {
      await withHardCap(hang.response, 4_000);
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(JsonWorkerRequestTimeoutError);
    expect(rejection).toMatchObject({
      name: "JsonWorkerRequestTimeoutError",
      code: "JSON_WORKER_REQUEST_TIMEOUT",
      requestId: hang.id,
      timeoutMs,
    });
    if (rejection instanceof JsonWorkerRequestTimeoutError) {
      expect(rejection.elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 10);
    }
    expect(client.isHealthy()).toBe(false);
  } finally {
    try {
      await client.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function withHardCap<T>(
  promise: Promise<T>,
  timeoutMs = 5_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`test hard cap exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function isProcessAlive(pid: number | null): boolean {
  if (pid === null) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return readCode(error) !== "ESRCH";
  }
}

function cleanupProcess(pid: number): void {
  if (!isProcessAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    void error;
    // Best-effort test cleanup only.
  }
}

function readCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
