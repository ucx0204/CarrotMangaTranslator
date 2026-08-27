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
