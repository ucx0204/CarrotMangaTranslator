import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  downloadToFile,
  ensureRemoteFile,
} from "../src/main/runtimeSupport/modelDownloads";
import { readNvidiaRedistPackage } from "../src/main/inpainting/fluxAssets/downloads";

const tempDirs: string[] = [];
const TEST_MAXIMUM_BYTES = 1024 * 1024;
const { setDownloadRetryWaitSchedulerForTests } =
  require("../src/main/runtime/transport/download-retry-wait.cjs") as {
    setDownloadRetryWaitSchedulerForTests: (
      scheduler: (
        delayMs: number,
        signal?: AbortSignal | null,
      ) => Promise<void>,
    ) => () => void;
  };
let restoreRetryWaitScheduler: (() => void) | null = null;
let retryWaitDelays: number[] = [];

describe("Flux asset downloads", () => {
  beforeEach(() => {
    retryWaitDelays = [];
    restoreRetryWaitScheduler = setDownloadRetryWaitSchedulerForTests(
      async (delayMs, signal) => {
        retryWaitDelays.push(delayMs);
        if (signal?.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException("Aborted", "AbortError");
        }
      },
    );
  });

  afterEach(async () => {
    restoreRetryWaitScheduler?.();
    restoreRetryWaitScheduler = null;
    vi.unstubAllGlobals();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) await rm(dir, { force: true, recursive: true });
    }
  });

  it("accepts NVIDIA decimal-string sizes and returns pinned metadata", () => {
    const entry = readNvidiaRedistPackage(
      {
        cuda_cudart: {
          "windows-x86_64": {
            relative_path:
              "cuda_cudart/windows-x86_64/cuda_cudart-windows-x86_64-12.9.37-archive.zip",
            sha256:
              "f96afe6df898bc8510c48b44668bd9f825731efbf460f3640a922b2b8ae59ccc",
            size: "3519893",
          },
        },
      },
      "cuda_cudart",
      "windows-x86_64",
    );

    expect(entry).toEqual({
      relative_path:
        "cuda_cudart/windows-x86_64/cuda_cudart-windows-x86_64-12.9.37-archive.zip",
      sha256:
        "f96afe6df898bc8510c48b44668bd9f825731efbf460f3640a922b2b8ae59ccc",
      size: 3_519_893,
    });
  });

  it.each([676_792_208, undefined, null])(
    "accepts compatible NVIDIA size value %s",
    (size) => {
      const entry = readNvidiaRedistPackage(
        {
          cudnn: {
            "windows-x86_64": {
              cuda12: {
                relative_path:
                  "cudnn/windows-x86_64/cudnn-windows-x86_64-9.21.0.82_cuda12-archive.zip",
                sha256:
                  "9c054b33f0e8f074f3b68fd446cdffe2cf875de5f01ed4541fa675e8fdd5ceed",
                size,
              },
            },
          },
        },
        "cudnn",
        "windows-x86_64",
        "cuda12",
      );

      expect(entry?.size).toBe(676_792_208);
    },
  );

  it.each([
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "",
    "0",
    "03519893",
    "3519893.0",
    "3.519893e6",
    " 3519893 ",
    true,
    {},
    [],
  ])("rejects malformed NVIDIA manifest size %o", (size) => {
    expect(() =>
      readNvidiaRedistPackage(
        {
          cuda_cudart: {
            "windows-x86_64": {
              relative_path:
                "cuda_cudart/windows-x86_64/cuda_cudart-windows-x86_64-12.9.37-archive.zip",
              sha256:
                "f96afe6df898bc8510c48b44668bd9f825731efbf460f3640a922b2b8ae59ccc",
              size,
            },
          },
        },
        "cuda_cudart",
        "windows-x86_64",
      ),
    ).toThrow("잘못된 파일 크기");
  });

  it("rejects a valid but unpinned NVIDIA manifest size", () => {
    expect(() =>
      readNvidiaRedistPackage(
        {
          cuda_cudart: {
            "windows-x86_64": {
              relative_path:
                "cuda_cudart/windows-x86_64/cuda_cudart-windows-x86_64-12.9.37-archive.zip",
              sha256:
                "f96afe6df898bc8510c48b44668bd9f825731efbf460f3640a922b2b8ae59ccc",
              size: "3519894",
            },
          },
        },
        "cuda_cudart",
        "windows-x86_64",
      ),
    ).toThrow("내장 무결성 정보와 일치하지 않습니다");
  });

  it("loads the shared app runtime downloader and records metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "manga-flux-download-"));
    tempDirs.push(dir);
    const outputPath = join(dir, "asset.bin");
    const url = "https://huggingface.co/example/repo/resolve/main/asset.bin";
    const body = Buffer.from("shared-runtime-download");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "content-length": String(body.length) },
        });
      }
      const range = new Headers(init?.headers).get("range");
      expect(range).toBe(`bytes=0-${body.length - 1}`);
      return new Response(body, {
        status: 206,
        headers: {
          "content-range": `bytes 0-${body.length - 1}/${body.length}`,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await downloadToFile({
      url,
      outputPath,
      progressText: "다운로드 중",
      label: "Flux test asset",
      maximumBytes: TEST_MAXIMUM_BYTES,
    });

    expect(await readFile(outputPath)).toEqual(body);
    expect(
      JSON.parse(await readFile(`${outputPath}.mgtmeta.json`, "utf8")),
    ).toEqual({
      url,
      bytes: body.length,
      downloadedAt: expect.any(String),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rehashes a cached file and removes a mismatched model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "manga-flux-checksum-"));
    tempDirs.push(dir);
    const body = Buffer.from("verified-metal-model");
    const url =
      "https://huggingface.co/example/repo/resolve/revision/model.gguf";
    const expectedSha256 = createHash("sha256").update(body).digest("hex");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "content-length": String(body.length) },
        });
      }
      return new Response(body, {
        status: 206,
        headers: {
          "content-range": `bytes 0-${body.length - 1}/${body.length}`,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const verifiedPath = await ensureRemoteFile({
      modelDir: dir,
      fileName: "model.gguf",
      label: "Metal model",
      url,
      expectedSha256,
      minimumBytes: 1,
      maximumBytes: TEST_MAXIMUM_BYTES,
    });
    const metadataPath = `${verifiedPath}.mgtmeta.json`;
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    expect(metadata).toMatchObject({
      url,
      bytes: body.length,
      mtimeMs: expect.any(Number),
      sha256: expectedSha256,
    });

    await writeFile(
      metadataPath,
      `${JSON.stringify({ ...metadata, mtimeMs: 0 })}\n`,
    );
    await ensureRemoteFile({
      modelDir: dir,
      fileName: "model.gguf",
      label: "Metal model",
      url,
      expectedSha256,
      minimumBytes: 1,
      maximumBytes: TEST_MAXIMUM_BYTES,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(metadataPath, "utf8")).mtimeMs).not.toBe(
      0,
    );

    await writeFile(verifiedPath, Buffer.alloc(body.length, 0x78));
    const restoredPath = await ensureRemoteFile({
      modelDir: dir,
      fileName: "model.gguf",
      label: "Metal model",
      url,
      expectedSha256,
      minimumBytes: 1,
      maximumBytes: TEST_MAXIMUM_BYTES,
    });
    expect(await readFile(restoredPath)).toEqual(body);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await expect(
      ensureRemoteFile({
        modelDir: dir,
        fileName: "invalid.gguf",
        label: "Invalid Metal model",
        url,
        expectedSha256: "0".repeat(64),
        minimumBytes: 1,
        maximumBytes: TEST_MAXIMUM_BYTES,
      }),
    ).rejects.toThrow(/체크섬|SHA-256/);
    await expect(readFile(join(dir, "invalid.gguf"))).rejects.toThrow();
    await expect(readFile(join(dir, "invalid.gguf.part"))).rejects.toThrow();
    expect(retryWaitDelays).toEqual([1000, 2000]);
  });

  it.each(["missing", "incomplete"] as const)(
    "recovers a valid committed payload with %s metadata without downloading",
    async (metadataState) => {
      const dir = await mkdtemp(join(tmpdir(), "manga-flux-recover-"));
      tempDirs.push(dir);
      const fileName = "committed.bin";
      const outputPath = join(dir, fileName);
      const metadataPath = `${outputPath}.mgtmeta.json`;
      const url =
        "https://huggingface.co/example/repo/resolve/revision/committed.bin";
      const body = Buffer.from("committed-before-metadata");
      const expectedSha256 = createHash("sha256").update(body).digest("hex");
      await writeFile(outputPath, body);
      if (metadataState === "incomplete") {
        await writeFile(
          metadataPath,
          `${JSON.stringify({
            url,
            bytes: body.length,
            downloadedAt: new Date().toISOString(),
          })}\n`,
        );
      }
      const fetchMock = vi.fn(async () => {
        throw new Error("valid committed payload must not be downloaded");
      });
      vi.stubGlobal("fetch", fetchMock);

      await ensureRemoteFile({
        modelDir: dir,
        fileName,
        label: "Committed asset",
        url,
        expectedSha256,
        minimumBytes: 1,
        maximumBytes: TEST_MAXIMUM_BYTES,
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(await readFile(outputPath)).toEqual(body);
      expect(JSON.parse(await readFile(metadataPath, "utf8"))).toMatchObject({
        url,
        bytes: body.length,
        mtimeMs: expect.any(Number),
        sha256: expectedSha256,
      });
    },
  );

  it("does not commit a cancelled checksummed download", async () => {
    const dir = await mkdtemp(join(tmpdir(), "manga-flux-abort-"));
    tempDirs.push(dir);
    const fileName = "cancelled.bin";
    const outputPath = join(dir, fileName);
    const url =
      "https://huggingface.co/example/repo/resolve/revision/cancelled.bin";
    const abortController = new AbortController();
    const expectedSha256 = createHash("sha256")
      .update("complete-payload")
      .digest("hex");
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
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "HEAD"
          ? new Response(null, { status: 200 })
          : new Response(body, { status: 200 }),
      ),
    );

    await expect(
      ensureRemoteFile({
        modelDir: dir,
        fileName,
        label: "Cancelled asset",
        url,
        expectedSha256,
        minimumBytes: 1,
        maximumBytes: TEST_MAXIMUM_BYTES,
        signal: abortController.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    await expect(readFile(outputPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(`${outputPath}.part`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(`${outputPath}.mgtmeta.json`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rehashes and removes a payload changed after its download receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "manga-flux-receipt-race-"));
    tempDirs.push(dir);
    const fileName = "receipt-race.bin";
    const outputPath = join(dir, fileName);
    const url =
      "https://huggingface.co/example/repo/resolve/revision/receipt-race.bin";
    const body = Buffer.from("verified-receipt-body");
    const expectedSha256 = createHash("sha256").update(body).digest("hex");
    let tampered = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": String(body.length) },
          });
        }
        return new Response(body, {
          status: 206,
          headers: {
            "content-range": `bytes 0-${body.length - 1}/${body.length}`,
          },
        });
      }),
    );

    await expect(
      ensureRemoteFile({
        modelDir: dir,
        fileName,
        label: "Receipt race asset",
        url,
        expectedSha256,
        expectedTotalBytes: body.length,
        minimumBytes: 1,
        maximumBytes: TEST_MAXIMUM_BYTES,
        onProgress(progress) {
          if (!tampered && progress.installLogLine?.includes("다운로드 완료")) {
            tampered = true;
            writeFileSync(outputPath, Buffer.alloc(body.length, 0x78));
            const oldTimestamp = new Date("2000-01-01T00:00:00.000Z");
            utimesSync(outputPath, oldTimestamp, oldTimestamp);
          }
        },
      }),
    ).rejects.toThrow("SHA-256 검증에 실패");

    expect(tampered).toBe(true);
    for (const suffix of ["", ".mgtmeta.json", ".mgt-sha256.json"]) {
      await expect(readFile(`${outputPath}${suffix}`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });
});
