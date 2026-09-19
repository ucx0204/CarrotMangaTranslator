import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CUDA_REDIST_MANIFEST_URL,
  CUDNN_REDIST_MANIFEST_URL,
  FLUX_CUDA_DLLS,
  FLUX_CUDA_RUNTIME_DIR,
  FLUX_CUDNN_DLLS,
} from "../src/main/inpainting/fluxAssets/constants";
import {
  ensureFluxCudaRuntime,
  runtimeMarkerPath,
} from "../src/main/inpainting/fluxAssets/cudaRuntime";
import { readNvidiaRedistPackage } from "../src/main/inpainting/fluxAssets/downloads";

// NVIDIA redistrib_12.9.0.json: cuFFT's DLL ABI is 11, not the CUDA major 12.
const CUFFT_FILE = "cufft64_11.dll";
const CUFFT_PACKAGE = {
  relative_path:
    "libcufft/windows-x86_64/libcufft-windows-x86_64-11.4.0.6-archive.zip",
  sha256: "caed5da0d48de61eb0acc600fe29a07c8a850d219ccc0d447ce08786d4564114",
  size: "198394513",
};
const LEGACY_CUDA_MANIFEST = {
  libcublas: {
    "windows-x86_64": {
      relative_path:
        "libcublas/windows-x86_64/libcublas-windows-x86_64-12.9.0.13-archive.zip",
      sha256:
        "20d9c2cd3810c948b875820917b38053dacf200b23cb3b8b8a14ff3569aa1f31",
      size: "549211990",
    },
  },
  cuda_cudart: {
    "windows-x86_64": {
      relative_path:
        "cuda_cudart/windows-x86_64/cuda_cudart-windows-x86_64-12.9.37-archive.zip",
      sha256:
        "f96afe6df898bc8510c48b44668bd9f825731efbf460f3640a922b2b8ae59ccc",
      size: "3519893",
    },
  },
  libcurand: {
    "windows-x86_64": {
      relative_path:
        "libcurand/windows-x86_64/libcurand-windows-x86_64-10.3.10.19-archive.zip",
      sha256:
        "d0411f0b8c07e90d0fb6e01bfa7a54c9cb80f2ddf67e4ded2d96a50e19aadad6",
      size: "67904600",
    },
  },
};
const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("shared Flux/Koharu CUDA cuFFT dependency", () => {
  it("requires the cuFFT 11 DLL for extraction and cache validation", () => {
    expect(FLUX_CUDA_DLLS.has(CUFFT_FILE)).toBe(true);
  });

  it("accepts the pinned NVIDIA cuFFT archive with its exact hash and size", () => {
    expect(
      readNvidiaRedistPackage(
        { libcufft: { "windows-x86_64": CUFFT_PACKAGE } },
        "libcufft",
        "windows-x86_64",
      ),
    ).toEqual({ ...CUFFT_PACKAGE, size: 198_394_513 });
  });

  it.each([{ sha256: "0".repeat(64) }, { size: "198394514" }])(
    "rejects altered cuFFT integrity metadata: %j",
    (override) => {
      expect(() =>
        readNvidiaRedistPackage(
          {
            libcufft: {
              "windows-x86_64": { ...CUFFT_PACKAGE, ...override },
            },
          },
          "libcufft",
          "windows-x86_64",
        ),
      ).toThrow();
    },
  );

  it("reuses a complete cache without a network request", async () => {
    const runtimeDir = await createRuntimeRoot();
    const cudaDir = await writeRuntimeCache(runtimeDir, "cufft");
    const markerBefore = await readFile(runtimeMarkerPath(cudaDir), "utf8");
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error("unexpected network"));
    vi.stubGlobal("fetch", fetchMock);

    await ensureFluxCudaRuntime({ runtimeDir });

    expect(fetchMock).not.toHaveBeenCalled();
    const markerAfter = await readFile(runtimeMarkerPath(cudaDir), "utf8");
    expect(markerAfter).toBe(markerBefore);
  });

  it.each([undefined, ""])(
    "starts repairing missing/empty cuFFT (%j) without losing the old cache on failure",
    async (cufftContents) => {
      const runtimeDir = await createRuntimeRoot();
      const cudaDir = await writeRuntimeCache(runtimeDir, cufftContents);
      const markerBefore = await readFile(runtimeMarkerPath(cudaDir), "utf8");
      const filesBefore = (await readdir(cudaDir)).sort();
      const networkError = new Error("offline during runtime repair");
      const fetchMock = vi.fn().mockRejectedValue(networkError);
      vi.stubGlobal("fetch", fetchMock);

      await expect(ensureFluxCudaRuntime({ runtimeDir })).rejects.toBe(
        networkError,
      );

      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        CUDA_REDIST_MANIFEST_URL,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      const markerAfter = await readFile(runtimeMarkerPath(cudaDir), "utf8");
      expect(markerAfter).toBe(markerBefore);
      expect((await readdir(cudaDir)).sort()).toEqual(filesBefore);
      const cudart = await readFile(join(cudaDir, "cudart64_12.dll"), "utf8");
      expect(cudart).toBe("runtime");
      expect((await readdir(runtimeDir)).sort()).toEqual(
        [".downloads", FLUX_CUDA_RUNTIME_DIR].sort(),
      );
    },
  );

  it("rejects a manifest missing cuFFT before downloading any archives", async () => {
    const runtimeDir = await createRuntimeRoot();
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify(LEGACY_CUDA_MANIFEST), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureFluxCudaRuntime({ runtimeDir })).rejects.toThrow(
      "필요한 DLL 패키지를 찾지 못했습니다",
    );

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      CUDA_REDIST_MANIFEST_URL,
      expect.anything(),
    );
    expect(await readdir(runtimeDir)).toEqual([".downloads"]);
    expect(await readdir(join(runtimeDir, ".downloads"))).toEqual([]);
  });
});

async function createRuntimeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mgt-cuda-cufft-"));
  tempDirs.push(root);
  return root;
}

async function writeRuntimeCache(
  runtimeDir: string,
  cufftContents: string | undefined,
): Promise<string> {
  const cudaDir = join(runtimeDir, FLUX_CUDA_RUNTIME_DIR);
  await mkdir(cudaDir, { recursive: true });
  for (const fileName of [...FLUX_CUDA_DLLS, ...FLUX_CUDNN_DLLS]) {
    if (fileName !== CUFFT_FILE) {
      await writeFile(join(cudaDir, fileName), "runtime");
    }
  }
  if (cufftContents !== undefined) {
    await writeFile(join(cudaDir, CUFFT_FILE), cufftContents);
  }
  await writeFile(
    runtimeMarkerPath(cudaDir),
    JSON.stringify({
      cudaManifest: CUDA_REDIST_MANIFEST_URL,
      cudnnManifest: CUDNN_REDIST_MANIFEST_URL,
      installedAt: "2026-09-16T00:00:00.000Z",
    }),
  );
  return cudaDir;
}
