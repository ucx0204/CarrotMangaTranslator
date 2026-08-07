import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as tsBudgets from "../src/main/runtimeSupport/downloadBudgets";

const cjsBudgets =
  require("../src/main/runtime/transport/download-budgets.cjs") as typeof tsBudgets;
const { collectRequiredHfDownloads } =
  require("../src/main/runtime/model/hf-model-download-tasks.cjs") as {
    collectRequiredHfDownloads: (
      options: Record<string, unknown>,
      target?: Record<string, unknown>,
    ) => Array<{ kind: string; maximumBytes: number }>;
  };
const { downloadHfFileWithProgress } =
  require("../src/main/runtime/simple-page-download-utils.cjs") as {
    downloadHfFileWithProgress: (
      task: DownloadTask,
      options?: Record<string, unknown>,
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

describe("download task budgets", () => {
  it("keeps TS and CJS download budget constants in parity", () => {
    expect(cjsBudgets).toMatchObject(tsBudgets);
  });

  it("assigns model, draft, and mmproj caps and keeps the aggregate at 160 GiB", async () => {
    const hubCacheDir = await createTempDir("model-task-caps-");
    const options = {
      modelRepo: "custom/model",
      modelFile: "model.gguf",
      mmprojRepo: "custom/mmproj",
      mmprojFile: "mmproj.gguf",
      draftModelRepo: "custom/draft",
      draftModelFile: "draft.gguf",
      hfHubCacheDir: hubCacheDir,
      useDraft: true,
    };
    const tasks = collectRequiredHfDownloads(options, {
      launchMode: "managed",
      modelPath: null,
      mmprojPath: null,
      mmprojUrl: "https://example.invalid/mmproj.gguf",
      draftModelPath: null,
      draftModelUrl: "https://example.invalid/draft.gguf",
    });
    expect(
      Object.fromEntries(tasks.map((task) => [task.kind, task.maximumBytes])),
    ).toEqual({
      model: tsBudgets.MAX_REMOTE_MODEL_FILE_BYTES,
      draft: tsBudgets.MAX_REMOTE_DRAFT_MODEL_FILE_BYTES,
      mmproj: tsBudgets.MAX_REMOTE_MMPROJ_FILE_BYTES,
    });
    expect(
      tsBudgets.MAX_REMOTE_MODEL_FILE_BYTES +
        tsBudgets.MAX_REMOTE_DRAFT_MODEL_FILE_BYTES +
        tsBudgets.MAX_REMOTE_MMPROJ_FILE_BYTES,
    ).toBe(tsBudgets.MAX_MODEL_DOWNLOAD_AGGREGATE_BYTES);
  });

  it("allows a looser waiter to attach to a stricter active download", async () => {
    const task = await createTask("attach-ok.bin", 8);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const active = downloadHfFileWithProgress(task);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const waiter = downloadHfFileWithProgress({ ...task, maximumBytes: 16 });
    controller.enqueue(Buffer.from("1234"));
    controller.close();
    await expect(Promise.all([active, waiter])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a stricter waiter instead of inheriting a looser active budget", async () => {
    const task = await createTask("attach-reject.bin", 16);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const active = downloadHfFileWithProgress(task);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await expect(
      downloadHfFileWithProgress({ ...task, maximumBytes: 8 }),
    ).rejects.toMatchObject({
      downloadBudgetMismatch: true,
      nonRetriable: true,
    });
    controller.enqueue(Buffer.from("1234"));
    controller.close();
    await active;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

async function createTask(
  file: string,
  maximumBytes: number,
): Promise<DownloadTask> {
  const dir = await createTempDir("active-budget-");
  return {
    label: "active budget test",
    file,
    url: `https://example.invalid/${file}`,
    destination: join(dir, file),
    maximumBytes,
  };
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `manga-${prefix}`));
  tempDirs.push(dir);
  return dir;
}
