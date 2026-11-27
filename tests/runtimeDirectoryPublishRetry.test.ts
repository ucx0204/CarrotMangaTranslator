import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRuntimeStagingDirectory,
  replaceDirectoryWithRollback,
} from "../src/main/runtimeSupport/runtimeDirectoryPublish";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { renameRuntimePathWithRetry } =
  require("../src/main/runtime/runtime-directory-publish.cjs") as {
    renameRuntimePathWithRetry: (
      source: string,
      destination: string,
      options?: {
        renamePath?: (source: string, destination: string) => Promise<unknown>;
        waitForRetry?: (delayMs: number) => Promise<unknown>;
      },
    ) => Promise<void>;
  };

describe("runtime directory publication retries", () => {
  it.runIf(process.platform === "win32")(
    "publishes the native runtime once Windows releases its staging directory",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "mgt-publish-"));
      const output = join(root, "cpu-torch");
      const staging = createRuntimeStagingDirectory(output);
      try {
        await mkdir(staging);
        await writeFile(join(staging, "version"), "new");
        await mkdir(output);
        await writeFile(join(output, "version"), "old");
        // Windows holds a process's current directory open without delete sharing.
        const child = spawn(
          process.execPath,
          ["-e", "process.stdin.resume(); process.stdout.write('ready')"],
          {
            cwd: staging,
            windowsHide: true,
            stdio: ["pipe", "pipe", "inherit"],
          },
        );
        const closed = once(child, "close");
        try {
          await once(child.stdout, "data");
          const release = setTimeout(() => child.stdin.end(), 250);
          try {
            await replaceDirectoryWithRollback(staging, output);
          } finally {
            clearTimeout(release);
          }
        } finally {
          child.stdin.end();
          await closed;
        }
        expect(await readFile(join(output, "version"), "utf8")).toBe("new");
        expect(await readdir(root)).toEqual(["cpu-torch"]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("restores the installed runtime when the replacement directory is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "mgt-rollback-"));
    const output = join(root, "cpu-torch");
    try {
      await mkdir(output);
      await writeFile(join(output, "version"), "old");
      await expect(
        replaceDirectoryWithRollback(join(root, "missing"), output),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(output, "version"), "utf8")).toBe("old");
      expect(await readdir(root)).toEqual(["cpu-torch"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("retries transient locks with bounded backoff", async () => {
    const transientError = Object.assign(new Error("runtime is busy"), {
      code: "ebusy",
    });
    const renamePath = vi
      .fn<(source: string, destination: string) => Promise<unknown>>()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce(undefined);
    const waitForRetry = vi
      .fn<(delayMs: number) => Promise<unknown>>()
      .mockResolvedValue(undefined);

    await renameRuntimePathWithRetry("runtime-staging", "runtime-output", {
      renamePath,
      waitForRetry,
    });

    expect(renamePath).toHaveBeenCalledTimes(2);
    expect(waitForRetry).toHaveBeenCalledWith(50);
  });

  it("does not retry permanent failures", async () => {
    const waitForRetry = vi
      .fn<(delayMs: number) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    for (const error of [
      Object.assign(new Error("different volume"), { code: "EXDEV" }),
      "invalid rename failure",
    ]) {
      const renamePath = vi
        .fn<(source: string, destination: string) => Promise<unknown>>()
        .mockRejectedValue(error);

      await expect(
        renameRuntimePathWithRetry("runtime-staging", "runtime-output", {
          renamePath,
          waitForRetry,
        }),
      ).rejects.toBe(error);
      expect(renamePath).toHaveBeenCalledTimes(1);
    }
    expect(waitForRetry).not.toHaveBeenCalled();
  });

  it("stops at the fixed retry budget", async () => {
    const transientError = Object.assign(new Error("runtime remains locked"), {
      code: "EACCES",
    });
    const renamePath = vi
      .fn<(source: string, destination: string) => Promise<unknown>>()
      .mockRejectedValue(transientError);
    const waitForRetry = vi
      .fn<(delayMs: number) => Promise<unknown>>()
      .mockResolvedValue(undefined);

    await expect(
      renameRuntimePathWithRetry("runtime-staging", "runtime-output", {
        renamePath,
        waitForRetry,
      }),
    ).rejects.toBe(transientError);

    expect(renamePath).toHaveBeenCalledTimes(12);
    expect(waitForRetry).toHaveBeenCalledTimes(11);
    expect(waitForRetry).toHaveBeenLastCalledWith(1000);
  });
});
