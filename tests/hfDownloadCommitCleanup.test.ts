import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("HF download committed artifact cleanup", () => {
  it.each(["stat failure", "size drift"] as const)(
    "removes the payload and sidecars after post-commit %s",
    async (failureMode) => {
      const directory = await mkdtemp(join(tmpdir(), "mgt-hf-commit-cleanup-"));
      tempDirs.push(directory);
      const destination = join(directory, "asset.bin");
      const body = Buffer.from("verified download body");
      const expectedSha256 = createHash("sha256").update(body).digest("hex");
      await writeFile(
        `${destination}.mgtmeta.json`,
        "stale metadata\n",
        "utf8",
      );
      vi.stubEnv("MANGA_TRANSLATOR_DOWNLOAD_RETRY_COUNT", "1");
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(body, {
              status: 206,
              headers: {
                "content-range": `bytes 0-${body.length - 1}/${body.length}`,
              },
            }),
        ),
      );

      const mutableFsPromises = require("node:fs/promises") as {
        stat: typeof import("node:fs/promises").stat;
      };
      const originalStat = mutableFsPromises.stat;
      mutableFsPromises.stat = (async (path, options) => {
        if (path === destination) {
          if (failureMode === "stat failure") {
            const error = Object.assign(
              new Error("simulated post-commit stat failure"),
              {
                code: "EIO",
              },
            );
            throw error;
          }
          const fileStat = await originalStat(path, options as never);
          return new Proxy(fileStat, {
            get(target, property, receiver) {
              return property === "size"
                ? target.size + 1
                : Reflect.get(target, property, receiver);
            },
          });
        }
        return originalStat(path, options as never);
      }) as typeof import("node:fs/promises").stat;

      const runtimePath =
        require.resolve("../src/main/runtime/transport/hf-download.cjs");
      try {
        delete require.cache[runtimePath];
        const { downloadHfFileWithProgress } = require(runtimePath) as {
          downloadHfFileWithProgress: (
            task: Record<string, unknown>,
          ) => Promise<unknown>;
        };

        const download = downloadHfFileWithProgress({
          url: "https://example.invalid/asset.bin",
          file: "asset.bin",
          destination,
          label: "commit cleanup test",
          maximumBytes: 1024,
          minimumBytes: 1,
          expectedTotalBytes: body.length,
          expectedSha256,
        });
        if (failureMode === "stat failure") {
          await expect(download).rejects.toMatchObject({ code: "EIO" });
        } else {
          await expect(download).rejects.toThrow("최종 파일 크기");
        }
      } finally {
        mutableFsPromises.stat = originalStat;
        delete require.cache[runtimePath];
      }

      for (const suffix of ["", ".mgtmeta.json", ".mgt-sha256.json"]) {
        await expect(readFile(`${destination}${suffix}`)).rejects.toMatchObject(
          {
            code: "ENOENT",
          },
        );
      }
    },
  );
});
