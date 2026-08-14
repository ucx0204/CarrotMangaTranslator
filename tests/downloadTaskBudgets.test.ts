import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    ) => Promise<DownloadReceipt>;
  };
const { validateDownloadContract } =
  require("../src/main/runtime/transport/download-contract.cjs") as {
    validateDownloadContract: (
      task: DownloadTask,
      progress: { totalBytes?: number },
    ) => unknown;
  };
const downloadContract =
  require("../src/main/runtime/transport/download-contract.cjs") as {
    assertCompatibleActiveDownload: (
      active: {
        url: string;
        maximumBytes: number;
        expectedSha256: string | null;
        expectedTotalBytes: number | null;
        minimumBytes: number | null;
      },
      task: DownloadTask,
      contract: DownloadContract,
    ) => void;
    assertReceiptMatchesTask: (
      task: DownloadTask,
      contract: DownloadContract,
      receipt: DownloadReceipt,
    ) => void;
    assertReceivedSize: (task: DownloadTask, receivedBytes: number) => void;
    validateDownloadContract: (
      task: DownloadTask,
      progress: { totalBytes?: number },
    ) => DownloadContract;
  };

type DownloadReceipt = Readonly<{
  receivedBytes: number;
  verifiedSha256: string | null;
  size: number;
  mtimeMs: number;
}>;

type DownloadContract = Readonly<{
  expectedSha256: string | null;
  expectedTotalBytes: number | null;
  minimumBytes: number | null;
}>;

type DownloadTask = {
  label: string;
  file: string;
  url: string;
  destination: string;
  maximumBytes: number;
  minimumBytes?: number;
  expectedTotalBytes?: number;
  expectedSha256?: string;
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
    const [activeReceipt, waiterReceipt] = await Promise.all([active, waiter]);
    expect(waiterReceipt).toBe(activeReceipt);
    expect(Object.isFrozen(activeReceipt)).toBe(true);
    expect(activeReceipt).toMatchObject({
      receivedBytes: 4,
      verifiedSha256: null,
      size: 4,
      mtimeMs: expect.any(Number),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["expectedSha256", "f".repeat(64)],
    ["expectedTotalBytes", 5],
    ["minimumBytes", 2],
  ] as const)(
    "rejects a waiter with a different %s contract",
    async (field, mismatchedValue) => {
      const body = Buffer.from("1234");
      const task = {
        ...(await createTask(`contract-${field}.bin`, 16)),
        expectedSha256: createHash("sha256").update(body).digest("hex"),
        expectedTotalBytes: body.length,
        minimumBytes: 1,
      };
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
            },
          }),
          {
            status: 206,
            headers: { "content-range": "bytes 0-3/4" },
          },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const active = downloadHfFileWithProgress(task);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await expect(
        downloadHfFileWithProgress({ ...task, [field]: mismatchedValue }),
      ).rejects.toMatchObject({
        mismatchField: field,
        downloadContractMismatch: true,
        nonRetriable: true,
      });
      controller.enqueue(body);
      controller.close();
      await active;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["", "not-a-sha256", "0".repeat(63)])(
    "rejects malformed expected SHA-256 %j before fetching",
    async (expectedSha256) => {
      const task = {
        ...(await createTask("invalid-sha.bin", 16)),
        expectedSha256,
      };
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchMock);

      await expect(downloadHfFileWithProgress(task)).rejects.toMatchObject({
        downloadIntegrityInvalid: true,
        nonRetriable: true,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects an overlong Windows download sidecar path before fetching", async () => {
    if (process.platform !== "win32") return;
    const directory = join(tmpdir(), "mgt-download-path-budget");
    const markerSuffix = ".mgt-sha256.json";
    const baseLength = resolve(
      `${join(directory, ".bin")}${markerSuffix}`,
    ).length;
    const destination = join(directory, `${"x".repeat(252 - baseLength)}.bin`);
    const derivedPath = resolve(`${destination}${markerSuffix}`);
    expect(derivedPath).toHaveLength(252);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadHfFileWithProgress({
        label: "long path test",
        file: "asset.bin",
        url: "https://example.invalid/asset.bin",
        destination,
        maximumBytes: 16,
      }),
    ).rejects.toMatchObject({
      destination,
      derivedPath,
      derivedPathKind: "integrity-metadata",
      derivedPathLength: 252,
      windowsPathCeiling: 252,
      windowsPathUnsafe: true,
      nonRetriable: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("budgets the compact remote-metadata temp for short destination names", async () => {
    if (process.platform !== "win32") return;
    const compactTempName = ".m-0000000000000000";
    const baseDirectory = join(tmpdir(), "mgt-download-temp-budget");
    const baseLength = resolve(join(baseDirectory, compactTempName)).length;
    const directory = `${baseDirectory}${"x".repeat(252 - baseLength)}`;
    const destination = join(directory, "a");
    const derivedPath = resolve(join(directory, compactTempName));
    expect(derivedPath).toHaveLength(252);
    expect(resolve(`${destination}.mgt-sha256.json`).length).toBeLessThan(252);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadHfFileWithProgress({
        label: "metadata temp path test",
        file: "a",
        url: "https://example.invalid/a",
        destination,
        maximumBytes: 16,
      }),
    ).rejects.toMatchObject({
      destination,
      derivedPath,
      derivedPathKind: "remote-metadata-temp",
      derivedPathLength: 252,
      windowsPathCeiling: 252,
      windowsPathUnsafe: true,
      nonRetriable: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves explicit Windows extended-length download paths", () => {
    if (process.platform !== "win32") return;
    const destination = `\\\\?\\C:\\${"nested\\".repeat(40)}asset.bin`;
    expect(`${destination}.mgt-sha256.json`.length).toBeGreaterThan(252);
    expect(() =>
      validateDownloadContract(
        {
          label: "extended path test",
          file: "asset.bin",
          url: "https://example.invalid/asset.bin",
          destination,
          maximumBytes: 16,
        },
        {},
      ),
    ).not.toThrow();
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

  it("rejects invalid minimum and expected-size contracts before transport", async () => {
    const task = await createTask("invalid-size-contract.bin", 8);
    for (const invalidTask of [
      { ...task, minimumBytes: 0 },
      { ...task, minimumBytes: 1.5 },
      { ...task, minimumBytes: 9 },
      { ...task, expectedTotalBytes: 0 },
      { ...task, minimumBytes: 5, expectedTotalBytes: 4 },
    ]) {
      expect(() =>
        downloadContract.validateDownloadContract(invalidTask, {}),
      ).toThrow();
    }
    expect(() =>
      downloadContract.validateDownloadContract(task, { totalBytes: 9 }),
    ).toThrow();
  });

  it("fails closed when received bytes or a completion receipt drift", async () => {
    const task = {
      ...(await createTask("receipt-contract.bin", 8)),
      expectedSha256: "a".repeat(64),
      expectedTotalBytes: 4,
      minimumBytes: 3,
    };
    const contract = downloadContract.validateDownloadContract(task, {});

    expect(() =>
      downloadContract.assertReceivedSize(
        { ...task, expectedTotalBytes: undefined },
        2,
      ),
    ).toThrow();
    expect(() => downloadContract.assertReceivedSize(task, 5)).toThrow();
    expect(() =>
      downloadContract.assertReceiptMatchesTask(task, contract, {
        receivedBytes: 4,
        verifiedSha256: contract.expectedSha256,
        size: 3,
        mtimeMs: 1,
      }),
    ).toThrow();
    expect(() =>
      downloadContract.assertReceiptMatchesTask(task, contract, {
        receivedBytes: 4,
        verifiedSha256: "b".repeat(64),
        size: 4,
        mtimeMs: 1,
      }),
    ).toThrow();
  });

  it("rejects same-destination joins whose URL differs", async () => {
    const task = await createTask("url-contract.bin", 8);
    const contract = downloadContract.validateDownloadContract(task, {});
    expect(() =>
      downloadContract.assertCompatibleActiveDownload(
        { url: `${task.url}?other`, maximumBytes: 8, ...contract },
        task,
        contract,
      ),
    ).toThrowError(/무결성 계약/);
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
