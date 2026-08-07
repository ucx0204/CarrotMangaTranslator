import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadToFile } from "../src/main/runtimeSupport/modelDownloads";

const { downloadHfFileWithProgress } =
  require("../src/main/runtime/simple-page-download-utils.cjs") as {
    downloadHfFileWithProgress: (
      task: DownloadTask,
      options?: Record<string, unknown>,
      progress?: { totalBytes?: number },
    ) => Promise<void>;
  };

type DownloadTask = {
  label: string;
  file: string;
  url: string;
  destination: string;
  maximumBytes: number;
};

const tempDirs: string[] = [];
const previousRetryCount = process.env.MANGA_TRANSLATOR_DOWNLOAD_RETRY_COUNT;

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
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("download response byte budgets", () => {
  it("rejects an oversized HEAD before GET or part creation", async () => {
    const task = await createTask("head-too-large.bin", 8);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 200, headers: { "content-length": "9" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadToFile({
        url: task.url,
        outputPath: task.destination,
        progressText: "download",
        label: task.label,
        maximumBytes: task.maximumBytes,
      }),
    ).rejects.toMatchObject({
      code: "DOWNLOAD_BUDGET_EXCEEDED",
      downloadBudgetExceeded: true,
      nonRetriable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expectMissing(task.destination);
    await expectMissing(`${task.destination}.part`);
  });

  it("cancels an oversized stream Content-Length before body copying", async () => {
    const task = await createTask("stream-header-over.bin", 8);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "content-length": "9" },
        }),
      ),
    );

    await expect(downloadHfFileWithProgress(task)).rejects.toMatchObject({
      code: "DOWNLOAD_BUDGET_EXCEEDED",
      maximumBytes: 8,
      receivedBytes: 9,
    });
    expect(cancelled).toBe(true);
    await expectMissing(task.destination);
    await expectMissing(`${task.destination}.part`);
  });

  it("stops an unknown-length stream before writing the byte over budget", async () => {
    const task = await createTask("stream-over.bin", 8);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.alloc(4, 1));
        controller.enqueue(Buffer.alloc(4, 2));
        controller.enqueue(Buffer.alloc(1, 3));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body, { status: 200 })),
    );

    await expect(downloadHfFileWithProgress(task)).rejects.toMatchObject({
      code: "DOWNLOAD_BUDGET_EXCEEDED",
      receivedBytes: 9,
      maximumBytes: 8,
    });
    expect(cancelled).toBe(true);
    await expectMissing(task.destination);
    await expectMissing(`${task.destination}.part`);
  });

  it("rejects a malicious oversized range body without fallback or retry", async () => {
    const task = await createTask("range-over.bin", 8);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(Buffer.from("12345"), {
        status: 206,
        headers: { "content-range": "bytes 0-3/4" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadHfFileWithProgress(task, {}, { totalBytes: 4 }),
    ).rejects.toMatchObject({
      code: "DOWNLOAD_BUDGET_EXCEEDED",
      receivedBytes: 5,
      maximumBytes: 4,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expectMissing(task.destination);
    await expectMissing(`${task.destination}.part`);
  });

  it("keeps short range bodies retryable before stream fallback", async () => {
    process.env.MANGA_TRANSLATOR_DOWNLOAD_RETRY_COUNT = "2";
    const task = await createTask("range-short.bin", 8);
    let rangeAttempts = 0;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_input, init) => {
        const range = new Headers(init?.headers).get("range");
        if (range) {
          rangeAttempts += 1;
          return new Response(Buffer.from("123"), {
            status: 206,
            headers: { "content-range": "bytes 0-3/4" },
          });
        }
        return new Response(Buffer.from("1234"), {
          status: 200,
          headers: { "content-length": "4" },
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    await downloadHfFileWithProgress(task, {}, { totalBytes: 4 });
    expect(rangeAttempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await readFile(task.destination, "utf8")).toBe("1234");
  });

  it("rejects an oversized range Content-Length before accepting the body", async () => {
    const task = await createTask("range-header-over.bin", 8);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(Buffer.from("12345"), {
        status: 206,
        headers: {
          "content-range": "bytes 0-3/4",
          "content-length": "5",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadHfFileWithProgress(task, {}, { totalBytes: 4 }),
    ).rejects.toMatchObject({
      code: "DOWNLOAD_BUDGET_EXCEEDED",
      receivedBytes: 5,
      maximumBytes: 4,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a known total above maximum before any fetch or truncate", async () => {
    const task = await createTask("known-too-large.bin", 8);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadHfFileWithProgress(task, {}, { totalBytes: 9 }),
    ).rejects.toMatchObject({ code: "DOWNLOAD_BUDGET_EXCEEDED" });
    expect(fetchMock).not.toHaveBeenCalled();
    await expectMissing(`${task.destination}.part`);
  });

  it("accepts a stream exactly at maximumBytes", async () => {
    const task = await createTask("exact.bin", 8);
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(Buffer.from("12345678"), { status: 200 }),
        ),
    );
    await downloadHfFileWithProgress(task);
    expect(await readFile(task.destination, "utf8")).toBe("12345678");
  });

  it.each([undefined, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid maximumBytes %s before network",
    async (maximumBytes) => {
      const task = await createTask("invalid.bin", 8);
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        downloadHfFileWithProgress({
          ...task,
          maximumBytes: maximumBytes as number,
        }),
      ).rejects.toMatchObject({
        code: "DOWNLOAD_BUDGET_INVALID",
        downloadBudgetInvalid: true,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

async function createTask(
  file: string,
  maximumBytes: number,
): Promise<DownloadTask> {
  const dir = await mkdtemp(join(tmpdir(), "manga-download-budget-"));
  tempDirs.push(dir);
  return {
    label: "테스트 파일",
    file,
    url: `https://example.invalid/${file}`,
    destination: join(dir, file),
    maximumBytes,
  };
}

async function expectMissing(filePath: string): Promise<void> {
  await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}
