import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { downloadToFile } from "../src/main/inpainting/fluxAssets/downloads";

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
});
