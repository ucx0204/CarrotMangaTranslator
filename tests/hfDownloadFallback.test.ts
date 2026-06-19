import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { downloadHfFileWithProgress } =
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
      },
    ) => Promise<void>;
  };

const tempDirs: string[] = [];
const previousRetryCount = process.env.MANGA_TRANSLATOR_DOWNLOAD_RETRY_COUNT;

describe("Hugging Face download fallback", () => {
  beforeEach(() => {
    process.env.MANGA_TRANSLATOR_DOWNLOAD_RETRY_COUNT = "1";
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (previousRetryCount === undefined) {
      delete process.env.MANGA_TRANSLATOR_DOWNLOAD_RETRY_COUNT;
    } else {
      process.env.MANGA_TRANSLATOR_DOWNLOAD_RETRY_COUNT = previousRetryCount;
    }
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

  it.each([401, 403, 404])(
    "does not fallback for HTTP %s range failures",
    async (status) => {
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
