import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { downloadHfFileWithProgress, resolveDownloadAbsoluteTimeoutMs } =
  require("../src/main/runtime/simple-page-download-utils.cjs") as {
    downloadHfFileWithProgress: (
      task: DownloadTask,
      options?: Record<string, unknown>,
    ) => Promise<void>;
    resolveDownloadAbsoluteTimeoutMs: (
      options?: Record<string, unknown>,
    ) => number;
  };
const {
  DEFAULT_DOWNLOAD_ABSOLUTE_TIMEOUT_MS,
  MAX_DOWNLOAD_ABSOLUTE_TIMEOUT_MS,
  MIN_DOWNLOAD_ABSOLUTE_TIMEOUT_MS,
} = require("../src/main/runtime/transport/download-budgets.cjs") as {
  DEFAULT_DOWNLOAD_ABSOLUTE_TIMEOUT_MS: number;
  MAX_DOWNLOAD_ABSOLUTE_TIMEOUT_MS: number;
  MIN_DOWNLOAD_ABSOLUTE_TIMEOUT_MS: number;
};

type DownloadTask = {
  label: string;
  file: string;
  url: string;
  destination: string;
  maximumBytes: number;
};

const tempDirs: string[] = [];
const envNames = [
  "MANGA_TRANSLATOR_DOWNLOAD_ABSOLUTE_TIMEOUT_MS",
  "MANGA_TRANSLATOR_DOWNLOAD_RETRY_COUNT",
] as const;
const originalEnv = new Map<string, string | undefined>();
const realSetTimeout = globalThis.setTimeout;

beforeEach(() => {
  for (const name of envNames) originalEnv.set(name, process.env[name]);
  delete process.env.MANGA_TRANSLATOR_DOWNLOAD_ABSOLUTE_TIMEOUT_MS;
  process.env.MANGA_TRANSLATOR_DOWNLOAD_RETRY_COUNT = "1";
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const name of envNames) {
    const value = originalEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalEnv.clear();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("absolute download deadline", () => {
  it("uses a 24 hour default and clamps configured values to 10m..72h", () => {
    expect(resolveDownloadAbsoluteTimeoutMs()).toBe(
      DEFAULT_DOWNLOAD_ABSOLUTE_TIMEOUT_MS,
    );
    expect(
      resolveDownloadAbsoluteTimeoutMs({ downloadAbsoluteTimeoutMs: 0 }),
    ).toBe(DEFAULT_DOWNLOAD_ABSOLUTE_TIMEOUT_MS);
    expect(
      resolveDownloadAbsoluteTimeoutMs({ downloadAbsoluteTimeoutMs: 1 }),
    ).toBe(MIN_DOWNLOAD_ABSOLUTE_TIMEOUT_MS);
    expect(
      resolveDownloadAbsoluteTimeoutMs({
        downloadAbsoluteTimeoutMs: MAX_DOWNLOAD_ABSOLUTE_TIMEOUT_MS * 2,
      }),
    ).toBe(MAX_DOWNLOAD_ABSOLUTE_TIMEOUT_MS);
  });

  it("terminates a continuous drip stream even while stall progress continues", async () => {
    const deadline = holdAbsoluteDeadlineTimer();
    const task = await createTask("drip.bin");
    let cancelled = false;
    let chunks = 0;
    let markContinuousProgress!: () => void;
    const continuousProgress = new Promise<void>((resolve) => {
      markContinuousProgress = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        return new Promise<void>((resolve) => {
          realSetTimeout(() => {
            if (!cancelled) {
              chunks += 1;
              controller.enqueue(Uint8Array.of(1));
              if (chunks === 2) markContinuousProgress();
            }
            resolve();
          }, 10);
        });
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const download = downloadHfFileWithProgress(task, {
      downloadAbsoluteTimeoutMs: MIN_DOWNLOAD_ABSOLUTE_TIMEOUT_MS,
    });
    const deadlineResult = expect(download).rejects.toMatchObject({
      code: "DOWNLOAD_DEADLINE_EXCEEDED",
      downloadDeadlineExceeded: true,
      nonRetriable: true,
      timeoutMs: MIN_DOWNLOAD_ABSOLUTE_TIMEOUT_MS,
    });
    await continuousProgress;
    deadline.fire();
    await deadlineResult;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chunks).toBeGreaterThan(1);
    expect(cancelled).toBe(true);
    await expectMissing(task.destination);
    await expectMissing(`${task.destination}.part`);
  });

  it("includes retry delay in the same deadline and never starts attempt two", async () => {
    accelerateAbsoluteDeadlineTimer();
    process.env.MANGA_TRANSLATOR_DOWNLOAD_RETRY_COUNT = "2";
    const task = await createTask("retry-delay.bin");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("retry", {
        status: 503,
        headers: { "retry-after": "3600" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadHfFileWithProgress(task, {
        downloadAbsoluteTimeoutMs: MIN_DOWNLOAD_ABSOLUTE_TIMEOUT_MS,
      }),
    ).rejects.toMatchObject({
      code: "DOWNLOAD_DEADLINE_EXCEEDED",
      downloadDeadlineExceeded: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function holdAbsoluteDeadlineTimer(): { fire(): void } {
  let callback: (() => void) | null = null;
  let heldTimer: ReturnType<typeof setTimeout> | null = null;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => {
    if ((timeout ?? 0) === MIN_DOWNLOAD_ABSOLUTE_TIMEOUT_MS) {
      heldTimer = realSetTimeout(() => {}, 60_000);
      heldTimer.unref?.();
      callback = () => {
        if (typeof handler !== "function") {
          throw new Error("Expected the download deadline to use a callback.");
        }
        handler(...args);
      };
      return heldTimer;
    }
    return realSetTimeout(handler, timeout, ...args);
  }) as typeof setTimeout);
  return {
    fire() {
      if (!callback) {
        throw new Error("The download deadline timer was not scheduled.");
      }
      if (heldTimer) clearTimeout(heldTimer);
      const fire = callback;
      callback = null;
      fire();
    },
  };
}

function accelerateAbsoluteDeadlineTimer(): void {
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) =>
    realSetTimeout(
      handler,
      (timeout ?? 0) >= MIN_DOWNLOAD_ABSOLUTE_TIMEOUT_MS ? 100 : timeout,
      ...args,
    )) as typeof setTimeout);
}

async function createTask(file: string): Promise<DownloadTask> {
  const dir = await mkdtemp(join(tmpdir(), "manga-download-deadline-"));
  tempDirs.push(dir);
  return {
    label: "deadline test",
    file,
    url: `https://example.invalid/${file}`,
    destination: join(dir, file),
    maximumBytes: 1024 * 1024,
  };
}

async function expectMissing(filePath: string): Promise<void> {
  await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}
