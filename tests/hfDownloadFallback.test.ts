import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { downloadHfFileWithProgress, resolveDownloadRetryDelayMs } =
  require("../src/main/runtime/simple-page-download-utils.cjs") as {
    downloadHfFileWithProgress: (
      task: {
        label: string;
        file: string;
        url: string;
        destination: string;
        progressPhase?: string;
      },
      options?: {
        abortSignal?: AbortSignal;
        onProgress?: (event: { installLogLine?: string }) => void;
      },
      progress?: {
        totalBytes?: number;
        onComplete?: (receivedBytes: number) => void;
      },
    ) => Promise<void>;
    resolveDownloadRetryDelayMs: (attempt: number, error: unknown) => number;
  };

const tempDirs: string[] = [];
const DOWNLOAD_IO_TEST_TIMEOUT_MS = 60_000;
const previousRetryCount = process.env.MANGA_TRANSLATOR_DOWNLOAD_RETRY_COUNT;
const previousConcurrency = process.env.MANGA_TRANSLATOR_DOWNLOAD_CONCURRENCY;
const previousChunkSizeMb = process.env.MANGA_TRANSLATOR_DOWNLOAD_CHUNK_SIZE_MB;

describe("Hugging Face download fallback", () => {
  it("honors Retry-After while adding bounded 429 jitter", () => {
    const delayMs = resolveDownloadRetryDelayMs(1, {
      status: 429,
      retryAfterMs: 5000,
    });

    expect(delayMs).toBeGreaterThanOrEqual(5000);
    expect(delayMs).toBeLessThan(5500);
  });

  beforeEach(() => {
    process.env.MANGA_TRANSLATOR_DOWNLOAD_RETRY_COUNT = "1";
    delete process.env.MANGA_TRANSLATOR_DOWNLOAD_CONCURRENCY;
    delete process.env.MANGA_TRANSLATOR_DOWNLOAD_CHUNK_SIZE_MB;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (previousRetryCount === undefined) {
      delete process.env.MANGA_TRANSLATOR_DOWNLOAD_RETRY_COUNT;
    } else {
      process.env.MANGA_TRANSLATOR_DOWNLOAD_RETRY_COUNT = previousRetryCount;
    }
    restoreEnv("MANGA_TRANSLATOR_DOWNLOAD_CONCURRENCY", previousConcurrency);
    restoreEnv("MANGA_TRANSLATOR_DOWNLOAD_CHUNK_SIZE_MB", previousChunkSizeMb);
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("falls back to a non-range stream once when ranged fetch fails", async () => {
    const body = "fallback-body";
    const task = await createTask("range-fetch-failed.bin");
    const progressEvents: Array<{ installLogLine?: string }> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (getRangeHeader(init)) {
        throw new TypeError("fetch failed");
      }
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(body.length) },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await downloadHfFileWithProgress(
      task,
      { onProgress: (event) => progressEvents.push(event) },
      { totalBytes: body.length },
    );

    expect(await readFile(task.destination, "utf8")).toBe(body);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getRangeHeader(fetchMock.mock.calls[0]?.[1])).toBe("bytes=0-12");
    expect(getRangeHeader(fetchMock.mock.calls[1]?.[1])).toBeUndefined();
    expect(
      progressEvents.some((event) =>
        event.installLogLine?.includes(
          "범위 다운로드 실패로 일반 다운로드로 전환",
        ),
      ),
    ).toBe(true);
  });

  it("does not repeat the fallback when the stream fallback also fails", async () => {
    const task = await createTask("fallback-fails.bin");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (getRangeHeader(init)) {
        throw new TypeError("fetch failed");
      }
      return new Response("unavailable", {
        status: 503,
        statusText: "Service Unavailable",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadHfFileWithProgress(task, {}, { totalBytes: 12 }),
    ).rejects.toThrow("테스트 파일 다운로드에 실패했습니다 (503).");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getRangeHeader(fetchMock.mock.calls[0]?.[1])).toBe("bytes=0-11");
    expect(getRangeHeader(fetchMock.mock.calls[1]?.[1])).toBeUndefined();
  });

  it("retries stream mode directly after a transient range fallback failure", async () => {
    process.env.MANGA_TRANSLATOR_DOWNLOAD_RETRY_COUNT = "2";
    const body = "recovered-stream";
    const task = await createTask("fallback-stream-retry.bin");
    const fetchMock = vi
      .fn(async (_url: string, init?: RequestInit) => {
        if (getRangeHeader(init)) {
          return new Response(body, { status: 200 });
        }
        return new Response("unavailable", { status: 503 });
      })
      .mockResolvedValueOnce(new Response(body, { status: 200 }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(body, {
          status: 200,
          headers: { "content-length": String(body.length) },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await downloadHfFileWithProgress(task, {}, { totalBytes: body.length });

    expect(await readFile(task.destination, "utf8")).toBe(body);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(getRangeHeader(fetchMock.mock.calls[0]?.[1])).toBe(
      `bytes=0-${body.length - 1}`,
    );
    expect(getRangeHeader(fetchMock.mock.calls[1]?.[1])).toBeUndefined();
    expect(getRangeHeader(fetchMock.mock.calls[2]?.[1])).toBeUndefined();
  });

  it("does not fallback after an abort error", async () => {
    const task = await createTask("abort.bin");
    const abortError = new Error("cancelled");
    abortError.name = "AbortError";
    const fetchMock = vi.fn(async () => {
      throw abortError;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadHfFileWithProgress(task, {}, { totalBytes: 4 }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404, 407])(
    "does not fallback for HTTP %s range failures",
    async (status) => {
      process.env.MANGA_TRANSLATOR_DOWNLOAD_RETRY_COUNT = "3";
      const task = await createTask(`http-${status}.bin`);
      const fetchMock = vi.fn(
        async (_url: string, _init?: RequestInit) =>
          new Response("denied", { status }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        downloadHfFileWithProgress(task, {}, { totalBytes: 4 }),
      ).rejects.toMatchObject({ status });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(getRangeHeader(fetchMock.mock.calls[0]?.[1])).toBe("bytes=0-3");
    },
  );

  it("does not retry a permanent HTTP failure in stream mode", async () => {
    process.env.MANGA_TRANSLATOR_DOWNLOAD_RETRY_COUNT = "3";
    const task = await createTask("stream-404.bin");
    const fetchMock = vi.fn(
      async () => new Response("missing", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadHfFileWithProgress(task)).rejects.toMatchObject({
      status: 404,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it(
    "downloads independent ranges concurrently and writes them in place",
    async () => {
      process.env.MANGA_TRANSLATOR_DOWNLOAD_CONCURRENCY = "3";
      process.env.MANGA_TRANSLATOR_DOWNLOAD_CHUNK_SIZE_MB = "1";
      const chunkSize = 1024 * 1024;
      const body = Buffer.alloc(chunkSize * 4);
      for (let index = 0; index < 4; index += 1) {
        body.fill(index + 1, index * chunkSize, (index + 1) * chunkSize);
      }
      const task = await createTask("parallel-ranges.bin");
      let activeRequests = 0;
      let maxActiveRequests = 0;
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const range = parseRangeHeader(getRangeHeader(init));
        if (range.start > 0) {
          expect(new Headers(init?.headers).get("if-range")).toBe(
            '"revision-a"',
          );
        }
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        await new Promise((resolve) =>
          setTimeout(resolve, range.start === 0 ? 1 : 20),
        );
        activeRequests -= 1;
        return new Response(body.subarray(range.start, range.end + 1), {
          status: 206,
          headers: {
            "content-range": `bytes ${range.start}-${range.end}/${body.length}`,
            etag: '"revision-a"',
          },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      await downloadHfFileWithProgress(task, {}, { totalBytes: body.length });

      expect(await readFile(task.destination)).toEqual(body);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(maxActiveRequests).toBe(3);
    },
    DOWNLOAD_IO_TEST_TIMEOUT_MS,
  );

  it(
    "restarts as a stream when the range validator changes",
    async () => {
      process.env.MANGA_TRANSLATOR_DOWNLOAD_CONCURRENCY = "1";
      process.env.MANGA_TRANSLATOR_DOWNLOAD_CHUNK_SIZE_MB = "1";
      const chunkSize = 1024 * 1024;
      const original = Buffer.alloc(chunkSize * 2, 1);
      const replacement = Buffer.alloc(chunkSize * 2, 2);
      const task = await createTask("range-revision-change.bin");
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const rangeHeader = getRangeHeader(init);
        if (!rangeHeader) {
          return new Response(replacement, {
            status: 200,
            headers: { "content-length": String(replacement.length) },
          });
        }
        const range = parseRangeHeader(rangeHeader);
        if (range.start === 0) {
          return new Response(original.subarray(0, chunkSize), {
            status: 206,
            headers: {
              "content-range": `bytes 0-${chunkSize - 1}/${original.length}`,
              etag: '"revision-a"',
            },
          });
        }
        expect(new Headers(init?.headers).get("if-range")).toBe('"revision-a"');
        return new Response(replacement, {
          status: 200,
          headers: { etag: '"revision-b"' },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      await downloadHfFileWithProgress(
        task,
        {},
        { totalBytes: original.length },
      );

      expect(await readFile(task.destination)).toEqual(replacement);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(getRangeHeader(fetchMock.mock.calls[2]?.[1])).toBeUndefined();
    },
    DOWNLOAD_IO_TEST_TIMEOUT_MS,
  );

  it("falls back to a stream when a server returns the wrong content range", async () => {
    const body = "fallback-body";
    const task = await createTask("invalid-content-range.bin");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (getRangeHeader(init)) {
        return new Response(body, {
          status: 206,
          headers: { "content-range": `bytes 1-${body.length}/${body.length}` },
        });
      }
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(body.length) },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await downloadHfFileWithProgress(task, {}, { totalBytes: body.length });

    expect(await readFile(task.destination, "utf8")).toBe(body);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a stream that ends before its advertised length", async () => {
    const task = await createTask("truncated-stream.bin");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("short", {
            status: 200,
            headers: { "content-length": "10" },
          }),
      ),
    );

    await expect(downloadHfFileWithProgress(task)).rejects.toMatchObject({
      expectedLength: 10,
      receivedLength: 5,
    });
    await expect(readFile(task.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(`${task.destination}.part`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not trust a short GET body over the earlier HEAD size", async () => {
    const task = await createTask("short-success-document.bin");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("short", {
            status: 200,
            headers: { "content-length": "5" },
          }),
      ),
    );

    await expect(
      downloadHfFileWithProgress(task, {}, { totalBytes: 10 }),
    ).rejects.toMatchObject({
      expectedLength: 10,
      receivedLength: 5,
    });
  });

  it("retries a failed stream from a clean partial file", async () => {
    process.env.MANGA_TRANSLATOR_DOWNLOAD_RETRY_COUNT = "2";
    const task = await createTask("stream-retry.bin");
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(
        new Response("recovered", {
          status: 200,
          headers: { "content-length": "9" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await downloadHfFileWithProgress(task);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await readFile(task.destination, "utf8")).toBe("recovered");
    await expect(readFile(`${task.destination}.part`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("shares one transfer when the same destination is requested twice", async () => {
    const task = await createTask("single-flight.bin");
    const firstComplete = vi.fn();
    const secondComplete = vi.fn();
    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response("shared", {
        status: 200,
        headers: { "content-length": "6" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([
      downloadHfFileWithProgress(task, {}, { onComplete: firstComplete }),
      downloadHfFileWithProgress(task, {}, { onComplete: secondComplete }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstComplete).toHaveBeenCalledWith(6);
    expect(secondComplete).toHaveBeenCalledWith(6);
    expect(await readFile(task.destination, "utf8")).toBe("shared");
  });

  it("does not retry a completed download when an observer throws", async () => {
    process.env.MANGA_TRANSLATOR_DOWNLOAD_RETRY_COUNT = "3";
    const task = await createTask("observer-error.bin");
    const fetchMock = vi.fn(
      async () =>
        new Response("complete", {
          status: 200,
          headers: { "content-length": "8" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await downloadHfFileWithProgress(
      task,
      {},
      {
        onComplete: () => {
          throw new Error("observer failed");
        },
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await readFile(task.destination, "utf8")).toBe("complete");
  });

  it(
    "shares the global request budget across different files",
    async () => {
      process.env.MANGA_TRANSLATOR_DOWNLOAD_CONCURRENCY = "2";
      process.env.MANGA_TRANSLATOR_DOWNLOAD_CHUNK_SIZE_MB = "1";
      const chunkSize = 1024 * 1024;
      const body = Buffer.alloc(chunkSize * 3, 7);
      const firstTask = await createTask("global-budget-a.bin");
      const secondTask = await createTask("global-budget-b.bin");
      let activeRequests = 0;
      let maxActiveRequests = 0;
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const range = parseRangeHeader(getRangeHeader(init));
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeRequests -= 1;
        return new Response(body.subarray(range.start, range.end + 1), {
          status: 206,
          headers: {
            "content-range": `bytes ${range.start}-${range.end}/${body.length}`,
          },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      await Promise.all([
        downloadHfFileWithProgress(firstTask, {}, { totalBytes: body.length }),
        downloadHfFileWithProgress(secondTask, {}, { totalBytes: body.length }),
      ]);

      expect(maxActiveRequests).toBe(2);
      expect(await readFile(firstTask.destination)).toEqual(body);
      expect(await readFile(secondTask.destination)).toEqual(body);
    },
    DOWNLOAD_IO_TEST_TIMEOUT_MS,
  );

  it("removes a partial stream after an abort failure", async () => {
    const task = await createTask("stream-abort.bin");
    const abortController = new AbortController();
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(Buffer.from("partial"));
          return;
        }
        abortController.abort();
        const error = new Error("cancelled while streaming");
        error.name = "AbortError";
        controller.error(error);
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    await expect(
      downloadHfFileWithProgress(task, {
        abortSignal: abortController.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    await expect(readFile(task.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(`${task.destination}.part`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

async function createTask(file: string) {
  const dir = await mkdtemp(join(tmpdir(), "manga-hf-download-"));
  tempDirs.push(dir);
  return {
    label: "테스트 파일",
    file,
    url: `https://huggingface.co/example/repo/resolve/main/${file}`,
    destination: join(dir, file),
  };
}

function getRangeHeader(init?: RequestInit) {
  const headers = init?.headers;
  if (!headers) {
    return undefined;
  }
  if (headers instanceof Headers) {
    return headers.get("Range") ?? headers.get("range") ?? undefined;
  }
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === "range")?.[1];
  }
  return (
    (headers as Record<string, string>).Range ??
    (headers as Record<string, string>).range
  );
}

function parseRangeHeader(value: string | undefined) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(value ?? "");
  if (!match) throw new Error(`unexpected range: ${String(value)}`);
  return { start: Number(match[1]), end: Number(match[2]) };
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
