import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppPaths } from "../src/main/appPaths";

const boundary = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(() => {
    throw new Error("Unexpected native worker spawn during GPU preflight");
  }),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: boundary.execFile,
  spawn: boundary.spawn,
}));

import {
  acquireFluxInpaintingEngine,
  disposeCachedFluxInpaintingEngine,
} from "../src/main/inpainting/fluxEnginePool";

// These rejection paths consume only dataRoot and must not prepare any assets.
const appPaths = {
  dataRoot: join(tmpdir(), "flux-preflight-unused"),
} as AppPaths;
const UUID = "GPU-22222222-2222-2222-2222-222222222222";

afterEach(async () => {
  expect(await disposeCachedFluxInpaintingEngine("preflight-test")).toBe(false);
  boundary.execFile.mockReset();
  boundary.spawn.mockClear();
});

describe("Flux engine pool GPU preflight", () => {
  it("rejects an incompatible SM75 GPU before preparing assets or a worker", async () => {
    respondWithGpu(`NVIDIA GeForce RTX 5070 Ti, 16303, 12.0, ${UUID}`);

    await expect(
      acquireFluxInpaintingEngine({
        appPaths,
        fluxBackend: "cuda-sm75-experimental",
        computeGpuIndex: 1,
      }),
    ).rejects.toThrow(
      "SM75 CUDA 경로에는 NVIDIA CUDA compute capability 7.5가 필요합니다. 감지값: 12",
    );
    expect(boundary.execFile).toHaveBeenCalledWith(
      "nvidia-smi",
      [
        "--id=1",
        "--query-gpu=name,memory.total,compute_cap,uuid",
        "--format=csv,noheader,nounits",
      ],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
    expect(boundary.spawn).not.toHaveBeenCalled();
  });

  it("does not guess a runner when the automatic GPU has no architecture", async () => {
    respondWithGpu(`NVIDIA GeForce RTX 5070 Ti, 16303, N/A, ${UUID}`);

    await expect(
      acquireFluxInpaintingEngine({ appPaths, fluxBackend: "cuda-native" }),
    ).rejects.toThrow("Flux CUDA GPU를 확정하지 못했습니다");
    expect(boundary.execFile).toHaveBeenCalledOnce();
    expect(boundary.spawn).not.toHaveBeenCalled();
  });

  it("rejects an invalid explicit index without querying a different GPU", async () => {
    await expect(
      acquireFluxInpaintingEngine({
        appPaths,
        fluxBackend: "cuda-native",
        computeGpuIndex: -1,
      }),
    ).rejects.toThrow("유효하지 않은 Flux 연산 GPU 번호");
    expect(boundary.execFile).not.toHaveBeenCalled();
    expect(boundary.spawn).not.toHaveBeenCalled();
  });

  it("honors cancellation before probing hardware or creating a worker", async () => {
    const controller = new AbortController();
    controller.abort(new Error("preflight cancelled"));

    await expect(
      acquireFluxInpaintingEngine({
        appPaths,
        fluxBackend: "cuda-native",
        signal: controller.signal,
      }),
    ).rejects.toThrow("preflight cancelled");
    expect(boundary.execFile).not.toHaveBeenCalled();
    expect(boundary.spawn).not.toHaveBeenCalled();
  });
});

function respondWithGpu(stdout: string): void {
  boundary.execFile.mockImplementation(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => callback(null, `${stdout}\n`, ""),
  );
}
