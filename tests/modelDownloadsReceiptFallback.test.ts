import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadToFile } from "../src/main/runtimeSupport/modelDownloads";

type RuntimeDownload = (
  task: {
    destination: string;
    expectedSha256?: string;
    expectedTotalBytes?: number;
  },
  options?: {
    abortSignal?: AbortSignal;
    onProgress?: (progress: unknown) => void;
  },
  progress?: { totalBytes?: number },
) => Promise<unknown>;

const downloadRuntime =
  require("../src/main/runtime/simple-page-download-utils.cjs") as {
    downloadHfFileWithProgress: RuntimeDownload;
  };
const actualDownload = downloadRuntime.downloadHfFileWithProgress;
const tempDirs: string[] = [];

afterEach(async () => {
  downloadRuntime.downloadHfFileWithProgress = actualDownload;
  vi.unstubAllGlobals();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("model download completion receipt fallback", () => {
  it("rehashes a pinned payload when an older runtime returns no receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "manga-receipt-fallback-"));
    tempDirs.push(directory);
    const outputPath = join(directory, "model.bin");
    const body = Buffer.from("compatible-runtime-payload");
    const expectedSha256 = createHash("sha256").update(body).digest("hex");
    let producedReceipt: unknown;

    downloadRuntime.downloadHfFileWithProgress = async (...args) => {
      producedReceipt = await actualDownload(...args);
      return undefined;
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, {
        status: 206,
        headers: {
          "content-range": `bytes 0-${body.length - 1}/${body.length}`,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await downloadToFile({
      url: "https://example.invalid/model.bin",
      outputPath,
      progressText: "download",
      label: "model.bin",
      expectedSha256,
      expectedTotalBytes: body.length,
      minimumBytes: 1,
      maximumBytes: 1024,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(producedReceipt)).toBe(true);
    expect(producedReceipt).toMatchObject({
      receivedBytes: body.length,
      verifiedSha256: expectedSha256,
      size: body.length,
      mtimeMs: expect.any(Number),
    });
    expect(await readFile(outputPath)).toEqual(body);
    expect(
      JSON.parse(await readFile(`${outputPath}.mgtmeta.json`, "utf8")),
    ).toMatchObject({
      bytes: body.length,
      sha256: expectedSha256,
      mtimeMs: expect.any(Number),
    });
  });
});
