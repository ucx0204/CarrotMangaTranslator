import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  downloadToFile,
  ensureRemoteFile,
} from "../src/main/inpainting/fluxAssets/downloads";

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

  it("records a verified checksum and removes a mismatched model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "manga-flux-checksum-"));
    tempDirs.push(dir);
    const body = Buffer.from("verified-metal-model");
    const url =
      "https://huggingface.co/example/repo/resolve/revision/model.gguf";
    const expectedSha256 = createHash("sha256").update(body).digest("hex");
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

    const verifiedPath = await ensureRemoteFile({
      modelDir: dir,
      fileName: "model.gguf",
      label: "Metal model",
      url,
      expectedSha256,
      minimumBytes: 1,
    });
    expect(
      JSON.parse(await readFile(`${verifiedPath}.mgtmeta.json`, "utf8")),
    ).toMatchObject({ url, bytes: body.length, sha256: expectedSha256 });

    await expect(
      ensureRemoteFile({
        modelDir: dir,
        fileName: "invalid.gguf",
        label: "Invalid Metal model",
        url,
        expectedSha256: "0".repeat(64),
        minimumBytes: 1,
      }),
    ).rejects.toThrow(/SHA-256 검증/);
    await expect(readFile(join(dir, "invalid.gguf"))).rejects.toThrow();
  });
});
