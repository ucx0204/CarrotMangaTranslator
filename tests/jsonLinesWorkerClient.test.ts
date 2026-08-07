import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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

const MALFORMED_SCRIPT = `
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (chunk.includes('"type":"shutdown"')) process.exit(0);
  process.stdout.write("{bad json\\n");
});
`;

const FAST_RESPONSE_SCRIPT = `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const req = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (req.type === "shutdown") process.exit(0);
    if (req.type !== "hang") {
      process.stdout.write(JSON.stringify({ id: req.id, ok: true }) + "\\n");
    }
  }
});
`;

const HANG_SCRIPT = `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const req = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (req.type === "shutdown") process.exit(0);
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
  });
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
    const { dir, scriptPath } = makeWorkerDir(MALFORMED_SCRIPT);
    const client = makeClient(scriptPath);
    try {
      const handle = client.startRequest({ type: "ping" });
      await expect(withHardCap(handle.response)).rejects.toThrow(
        /응답 프로토콜 오류/,
      );
      expect(client.isHealthy()).toBe(false);
    } finally {
      try {
        await client.dispose();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

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
    const { dir, scriptPath } = makeWorkerDir(FAST_RESPONSE_SCRIPT);
    const client = makeClient(scriptPath, { requestTimeoutMs: 80 });
    try {
      await expect(
        client.startRequest({ type: "ping" }).response,
      ).resolves.toMatchObject({ ok: true });
      await delay(180);
      expect(client.isHealthy()).toBe(true);
    } finally {
      try {
        await client.dispose();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("keeps AbortError only on the request that initiated worker termination", async () => {
    const { dir, scriptPath } = makeWorkerDir(HANG_SCRIPT);
    const client = makeClient(scriptPath);
    const controller = new AbortController();
    try {
      const primary = client.startRequest({ type: "hang" }, controller.signal);
      const other = client.startRequest({ type: "hang" });
      const settledPromise = Promise.allSettled([
        primary.response,
        other.response,
      ]);
      controller.abort();
      const [primaryResult, otherResult] = await withHardCap(settledPromise);

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
    } finally {
      try {
        await client.dispose();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("coalesces concurrent dispose calls into one promise", async () => {
    const { dir, scriptPath } = makeWorkerDir(FAST_RESPONSE_SCRIPT);
    const client = makeClient(scriptPath);
    try {
      const first = client.dispose();
      const second = client.dispose();
      expect(first).toBe(second);
      await withHardCap(first);
      expect(client.isHealthy()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("force-terminates a worker that ignores the shutdown message", async () => {
    const { dir, scriptPath } = makeWorkerDir(IGNORE_SHUTDOWN_SCRIPT);
    let pid: number | null = null;
    const client = makeClient(scriptPath, {
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
    const { dir, scriptPath } = makeWorkerDir(HANG_SCRIPT);
    let pid: number | null = null;
    const client = makeClient(scriptPath, {
      onSpawn: (spawnedPid) => {
        pid = spawnedPid;
      },
    });
    try {
      const handle = client.startRequest({ type: "hang" });
      const disposal = client.dispose();
      const [requestResult, disposeResult] = await withHardCap(
        Promise.allSettled([handle.response, disposal]),
      );
      expect(requestResult.status).toBe("rejected");
      expect(disposeResult.status).toBe("fulfilled");
      expect(isProcessAlive(pid)).toBe(false);
    } finally {
      if (pid !== null) {
        cleanupProcess(pid);
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function expectNoiseDoesNotExtendDeadline(
  stream: "stdout" | "stderr",
): Promise<void> {
  const { dir, scriptPath } = makeWorkerDir(noisyHangScript(stream));
  const timeoutMs = 1_000;
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

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
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
