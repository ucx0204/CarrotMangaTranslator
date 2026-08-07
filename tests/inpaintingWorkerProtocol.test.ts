import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FluxWorker } from "../src/main/inpainting/fluxWorker";
import type {
  FluxWorkerBackend,
  FluxWorkerRequest,
} from "../src/main/inpainting/fluxWorkerTypes";
import { KoharuWorker } from "../src/main/inpainting/koharuWorker";
import type { KoharuWorkerRequest } from "../src/main/inpainting/koharuWorkerTypes";

const WORKER_FIXTURE = String.raw`
const readline = require("node:readline");
const mode = process.argv[2];
const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "shutdown") {
    process.exit(0);
  }
  if (mode === "success") {
    process.stdout.write(JSON.stringify({
      id: request.id,
      ok: true,
      elapsed_ms: 7,
      error: null,
    }) + "\n");
    return;
  }
  if (mode === "failure") {
    process.stdout.write(JSON.stringify({
      id: request.id,
      ok: false,
      error: "fixture failure",
    }) + "\n");
    return;
  }
  if (mode === "malformed") {
    // { 로 시작하지만 파싱 불가능한 진짜 손상 응답. 비-JSON 노이즈(CUDA 경고)는
    // 이제 스킵되므로, 프로토콜 오류 경로를 검증하려면 { 로 시작해야 한다.
    process.stdout.write('{"id": "broken\n');
    return;
  }
  if (mode === "missing-id") {
    process.stdout.write(JSON.stringify({ ok: true }) + "\n");
    return;
  }
  if (mode === "unknown-id") {
    process.stdout.write(JSON.stringify({
      id: "unknown-request",
      ok: true,
    }) + "\n");
    return;
  }
  if (mode === "oversized") {
    process.stdout.write("x".repeat(1024 * 1024 + 1));
    return;
  }
  if (mode === "exit") {
    process.stderr.write("fixture-exit-detail\n", () => process.exit(23));
    return;
  }
  if (mode === "active") {
    let activityCount = 0;
    const activity = setInterval(() => {
      activityCount += 1;
      process.stderr.write("fixture-progress-" + activityCount + "\n");
      if (activityCount < 4) return;
      clearInterval(activity);
      process.stdout.write(JSON.stringify({
        id: request.id,
        ok: true,
        elapsed_ms: 720,
        error: null,
      }) + "\n");
    }, 180);
  }
});
`;

const FLUX_REQUEST: FluxWorkerRequest = {
  input: "input.png",
  mask: "mask.png",
  output: "output.png",
  steps: 4,
  strength: 0.8,
  maxPixels: 1024 * 1024,
  maskPadding: 8,
};

const KOHARU_REQUEST: KoharuWorkerRequest = {
  input: "input.png",
  mask: "mask.png",
  bubbleMask: "bubble-mask.png",
  output: "output.png",
  windows: [[1, 2, 30, 40]],
  maxPixels: 1024 * 1024,
};

type DisposableWorker = {
  dispose: () => Promise<void>;
  isHealthy: () => boolean;
};

const workers: DisposableWorker[] = [];
const tempDirs: string[] = [];
let previousLogPath: string | undefined;
let workerFixturePath = "";

beforeEach(() => {
  previousLogPath = process.env.MANGA_TRANSLATOR_LOG_PATH;
  const logDir = join(
    tmpdir(),
    `mgt-worker-protocol-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(logDir, { recursive: true });
  tempDirs.push(logDir);
  workerFixturePath = join(logDir, "worker-fixture.cjs");
  writeFileSync(workerFixturePath, WORKER_FIXTURE, "utf8");
  process.env.MANGA_TRANSLATOR_LOG_PATH = join(logDir, "worker.log");
});

afterEach(async () => {
  await Promise.allSettled(workers.splice(0).map((worker) => worker.dispose()));
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (previousLogPath === undefined) {
    delete process.env.MANGA_TRANSLATOR_LOG_PATH;
  } else {
    process.env.MANGA_TRANSLATOR_LOG_PATH = previousLogPath;
  }
});

describe("inpainting worker JSON-lines protocol", () => {
  it.each([
    "cuda-native",
    "zluda-native",
    "metal-native",
    "python-rocm",
    "python-cpu",
  ] satisfies FluxWorkerBackend[])(
    "accepts the shared Rust success response on the %s launch path",
    async (backend) => {
      const worker = createFluxWorker("success", 2_000, backend);

      await expect(worker.inpaint(FLUX_REQUEST)).resolves.toBeUndefined();
      expect(worker.isHealthy()).toBe(true);
    },
  );

  it("matches concurrent Flux responses to their requests and remains healthy", async () => {
    const worker = createFluxWorker("success");

    await expect(
      Promise.all([
        worker.inpaint(FLUX_REQUEST),
        worker.inpaint({
          ...FLUX_REQUEST,
          input: "second-input.png",
          output: "second-output.png",
        }),
      ]),
    ).resolves.toEqual([undefined, undefined]);
    expect(worker.isHealthy()).toBe(true);
  });

  it("handles a normal Koharu response and remains healthy", async () => {
    const worker = createKoharuWorker("success");

    await expect(worker.inpaint(KOHARU_REQUEST)).resolves.toBeUndefined();
    expect(worker.isHealthy()).toBe(true);
  });

  it("serializes writes when a request exceeds child-process pipe capacity", async () => {
    const worker = createKoharuWorker("success");
    const largeWindows = Array.from(
      { length: 20_000 },
      (): [number, number, number, number] => [1, 2, 30, 40],
    );

    await expect(
      Promise.all([
        worker.inpaint({ ...KOHARU_REQUEST, windows: largeWindows }),
        worker.inpaint(KOHARU_REQUEST),
      ]),
    ).resolves.toEqual([undefined, undefined]);
    expect(worker.isHealthy()).toBe(true);
  });

  it("maps valid worker failure responses without terminating the process", async () => {
    const fluxWorker = createFluxWorker("failure");
    const koharuWorker = createKoharuWorker("failure");

    await expect(fluxWorker.inpaint(FLUX_REQUEST)).rejects.toThrow(
      /Flux 인페인팅 실패: fixture failure/,
    );
    await expect(koharuWorker.inpaint(KOHARU_REQUEST)).rejects.toThrow(
      /Koharu 인페인팅 실패: fixture failure/,
    );
    expect(fluxWorker.isHealthy()).toBe(true);
    expect(koharuWorker.isHealthy()).toBe(true);
  });

  it("rejects malformed JSON immediately and terminates the worker", async () => {
    const worker = createFluxWorker("malformed", 2_000);

    await expect(worker.inpaint(FLUX_REQUEST)).rejects.toThrow(
      /응답 프로토콜 오류: JSON을 해석할 수 없습니다/,
    );
    expect(worker.isHealthy()).toBe(false);
  });

  it("rejects responses with a missing request ID", async () => {
    const worker = createKoharuWorker("missing-id", 2_000);

    await expect(worker.inpaint(KOHARU_REQUEST)).rejects.toThrow(
      /응답 프로토콜 오류: id와 ok가 올바르지 않습니다/,
    );
    expect(worker.isHealthy()).toBe(false);
  });

  it("rejects unknown request IDs instead of leaving requests pending", async () => {
    const worker = createFluxWorker("unknown-id", 2_000);

    await expect(worker.inpaint(FLUX_REQUEST)).rejects.toThrow(
      /응답 프로토콜 오류: 알 수 없는 요청 ID.*unknown-request/,
    );
    expect(worker.isHealthy()).toBe(false);
  });

  it("bounds unterminated response lines instead of growing memory indefinitely", async () => {
    const worker = createFluxWorker("oversized", 2_000);

    await expect(worker.inpaint(FLUX_REQUEST)).rejects.toThrow(
      /응답 한 줄이 최대 길이 1048576자를 초과했습니다/,
    );
    expect(worker.isHealthy()).toBe(false);
  });

  it("times out a missing response at the absolute deadline and terminates the worker", async () => {
    const worker = createFluxWorker("idle", 100);

    await expect(worker.inpaint(FLUX_REQUEST)).rejects.toThrow(
      /절대 응답 제한 100ms를 초과했습니다/,
    );
    expect(worker.isHealthy()).toBe(false);
  });

  it("does not let worker progress extend the absolute request deadline", async () => {
    const worker = createFluxWorker("active", 500);

    await expect(worker.inpaint(FLUX_REQUEST)).rejects.toThrow(
      /절대 응답 제한 500ms를 초과했습니다/,
    );
    expect(worker.isHealthy()).toBe(false);
  });

  it("aborts the request and all work in the process", async () => {
    const worker = createKoharuWorker("idle", 2_000);
    const controller = new AbortController();
    const inpaint = worker.inpaint(KOHARU_REQUEST, controller.signal);

    controller.abort();

    await expect(inpaint).rejects.toMatchObject({
      name: "AbortError",
      message: "Aborted",
    });
    expect(worker.isHealthy()).toBe(false);
  });

  it("does not misclassify collateral work as user cancellation", async () => {
    const worker = createKoharuWorker("idle", 2_000);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = worker.inpaint(KOHARU_REQUEST, firstController.signal);
    const second = worker.inpaint(
      { ...KOHARU_REQUEST, output: "second-output.png" },
      secondController.signal,
    );

    firstController.abort();

    await expect(first).rejects.toMatchObject({
      name: "AbortError",
      message: "Aborted",
    });
    await expect(second).rejects.toMatchObject({
      name: "Error",
      message: expect.stringContaining("다른 요청의 취소"),
    });
    expect(secondController.signal.aborted).toBe(false);
    expect(worker.isHealthy()).toBe(false);
  });

  it("rejects pending work when disposed and refuses later requests", async () => {
    const worker = createFluxWorker("idle", 2_000);
    const inpaint = worker.inpaint(FLUX_REQUEST);
    const rejection = expect(inpaint).rejects.toThrow(/워커가 종료되었습니다/);

    await worker.dispose();

    await rejection;
    expect(worker.isHealthy()).toBe(false);
    await expect(worker.inpaint(FLUX_REQUEST)).rejects.toThrow(
      /실행 중이 아닙니다/,
    );
  });

  it("rejects with stderr detail when the child exits during a request", async () => {
    const worker = createFluxWorker("exit", 2_000);

    await expect(worker.inpaint(FLUX_REQUEST)).rejects.toThrow(
      /종료되었습니다 \(23\).*fixture-exit-detail/,
    );
    expect(worker.isHealthy()).toBe(false);
  });

  it("rejects a child-process spawn error and remains closed", async () => {
    const missingExecutable = join(
      tmpdir(),
      `missing-worker-${Date.now()}-${Math.random().toString(16).slice(2)}.exe`,
    );
    const worker = new FluxWorker(
      {
        backend: "python-cpu",
        executable: missingExecutable,
        args: [],
        runtimePath: "test-runtime",
        label: "spawn-error-fixture",
      },
      { requestTimeoutMs: 2_000 },
    );
    workers.push(worker);

    await expect(worker.inpaint(FLUX_REQUEST)).rejects.toThrow(/ENOENT/);
    expect(worker.isHealthy()).toBe(false);
  });

  it("rejects invalid timeout configuration before spawning", () => {
    expect(() => createFluxWorker("success", 0)).toThrow(
      /timeout은 0보다 큰 유한한 값/,
    );
  });
});

function createFluxWorker(
  mode: string,
  requestTimeoutMs = 2_000,
  backend: FluxWorkerBackend = "python-cpu",
): FluxWorker {
  const worker = new FluxWorker(
    {
      backend,
      executable: process.execPath,
      args: [workerFixturePath, mode],
      runtimePath: "test-runtime",
      label: `${mode}-fixture`,
    },
    { requestTimeoutMs },
  );
  workers.push(worker);
  return worker;
}

function createKoharuWorker(
  mode: string,
  requestTimeoutMs = 2_000,
): KoharuWorker {
  const worker = new KoharuWorker(
    {
      backend: "cpu",
      executable: process.execPath,
      args: [workerFixturePath, mode],
      runtimePath: "test-runtime",
      label: `${mode}-fixture`,
    },
    { requestTimeoutMs },
  );
  workers.push(worker);
  return worker;
}
