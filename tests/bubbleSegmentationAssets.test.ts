import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureKoharuWorkerLaunch: vi.fn(),
  ensureRemoteFile: vi.fn(),
}));

vi.mock("../src/main/inpainting/fluxAssets", () => ({
  createCombinedDownloadProgress: () => ({ forFile: () => undefined }),
  ensureRemoteFile: mocks.ensureRemoteFile,
  hfResolveUrl: (repo: string, file: string, revision: string) =>
    `https://huggingface.co/${repo}/resolve/${revision}/${file}`,
}));

vi.mock("../src/main/inpainting/koharuAssets", () => ({
  ensureKoharuWorkerLaunch: mocks.ensureKoharuWorkerLaunch,
}));

import { ensureBubbleSegmentationWorkerLaunch } from "../src/main/inpainting/bubbleSegmentationAssets";

describe("speech bubble segmentation assets", () => {
  beforeEach(() => {
    mocks.ensureRemoteFile.mockReset();
    mocks.ensureKoharuWorkerLaunch.mockReset();
    mocks.ensureRemoteFile.mockImplementation(
      async (options: { modelDir: string; fileName: string }) =>
        join(options.modelDir, options.fileName),
    );
    mocks.ensureKoharuWorkerLaunch.mockResolvedValue({});
  });

  it("pins checksums for both the config and model", async () => {
    await ensureBubbleSegmentationWorkerLaunch({
      backend: "cpu",
      cudaRuntimeDir: "C:/runtime/cuda",
      modelDir: "C:/models/bubble-segmentation",
      runtimeDir: "C:/runtime/koharu",
    });

    expect(mocks.ensureRemoteFile).toHaveBeenCalledTimes(2);
    const calls = mocks.ensureRemoteFile.mock.calls.map(([options]) => options);
    expect(
      calls.find((options) => options.fileName === "config.json"),
    ).toMatchObject({
      expectedSha256:
        "36bb5b9c58a9bfbd9eebcf3569d9019ebb67585d4b572bd3762f7ecc15ebd6b5",
    });
    expect(
      calls.find((options) => options.fileName === "model.safetensors"),
    ).toMatchObject({
      expectedSha256:
        "c881d96771755fa628a94bb5f4b18301a0728ae4ffe8f14b2e9dde55e1b40552",
    });
  });
});
