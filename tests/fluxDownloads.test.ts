import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  downloadToFile,
  ensureRemoteFile,
} from "../src/main/runtimeSupport/modelDownloads";

const tempDirs: string[] = [];

describe("Flux asset downloads", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) await rm(dir, { force: true, recursive: true });
    }
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
    });

    expect(await readFile(outputPath)).toEqual(body);
    expect(
      JSON.parse(await readFile(`${outputPath}.mgtmeta.json`, "utf8")),
    ).toMatchObject({ url, bytes: body.length });
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
      }),
    ).rejects.toThrow(/체크섬|SHA-256/);
    await expect(readFile(join(dir, "invalid.gguf"))).rejects.toThrow();
    await expect(readFile(join(dir, "invalid.gguf.part"))).rejects.toThrow();
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
});
