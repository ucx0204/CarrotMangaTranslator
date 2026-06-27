import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  ensureKoharuWorkerLaunch,
  resolveKoharuModelFiles,
} from "../src/main/inpainting/koharuAssets";
import {
  CUDNN_REDIST_MANIFEST_URL,
  FLUX_CUDA_DLLS,
  FLUX_CUDA_RUNTIME_DIR,
  FLUX_CUDA_RUNTIME_MARKER,
  FLUX_CUDNN_DLLS,
} from "../src/main/inpainting/fluxAssets/constants";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  delete process.env.MANGA_TRANSLATOR_LOG_PATH;
  delete process.env.MGT_KOHARU_INPAINT_EXE;
});

describe("Koharu inpainting public surface", () => {
  it("maps Koharu model ids to their managed Hugging Face files", () => {
    expect(resolveKoharuModelFiles("lama-manga")).toEqual({
      repo: "mayocream/lama-manga",
      files: ["lama-manga.safetensors"],
    });
    expect(resolveKoharuModelFiles("aot-inpainting")).toEqual({
      repo: "mayocream/aot-inpainting",
      files: ["config.json", "model.safetensors"],
    });
    expect(() => resolveKoharuModelFiles("flux-klein")).toThrow(/Koharu 모델/);
  });

  it("re-exports the Koharu engine preparation entry point", async () => {
    vi.doMock("electron", () => ({
      nativeImage: {
        createFromBitmap: vi.fn(),
        createFromBuffer: vi.fn(),
        createFromPath: vi.fn(),
      },
    }));

    const { prepareKoharuInpaintingEngine } =
      await import("../src/main/inpainting");

    expect(typeof prepareKoharuInpaintingEngine).toBe("function");
  });

  it("puts the managed Flux CUDA runtime first for native Koharu CUDA", async () => {
    const runtimeDir = createTempDir("mgt-koharu-runtime-");
    const fluxRuntimeDir = createTempDir("mgt-koharu-flux-runtime-");
    const runnerDir = createTempDir("mgt-koharu-runner-");
    const runnerPath = join(runnerDir, "mgt-koharu-inpaint-runner.exe");
    writeFileSync(runnerPath, "runner");
    process.env.MGT_KOHARU_INPAINT_EXE = runnerPath;
    process.env.MANGA_TRANSLATOR_LOG_PATH = join(runtimeDir, "app.log");
    const cudaDir = writeCachedFluxCudaRuntime(fluxRuntimeDir);

    const launch = await ensureKoharuWorkerLaunch({
      runtimeDir,
      cudaRuntimeDir: fluxRuntimeDir,
      model: "lama-manga",
      modelFiles: {
        model: "lama-manga",
        weightsPath: join(runtimeDir, "lama-manga.safetensors"),
      },
      backend: "cuda-native",
    });

    expect(launch.env?.PATH?.split(delimiter)[0]).toBe(cudaDir);
    expect(launch.args).toEqual(
      expect.arrayContaining(["--cuda-runtime-dir", cudaDir]),
    );
    expect(launch.env?.KOHARU_DATA_ROOT).toBe(join(runtimeDir, "koharu-data"));
  });
});

function createTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  tempDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeCachedFluxCudaRuntime(runtimeDir: string): string {
  const cudaDir = join(runtimeDir, FLUX_CUDA_RUNTIME_DIR);
  mkdirSync(cudaDir, { recursive: true });
  for (const fileName of [...FLUX_CUDA_DLLS, ...FLUX_CUDNN_DLLS]) {
    writeFileSync(join(cudaDir, fileName), fileName);
  }
  writeFileSync(
    join(cudaDir, FLUX_CUDA_RUNTIME_MARKER),
    `${JSON.stringify({ cudnnManifest: CUDNN_REDIST_MANIFEST_URL })}\n`,
  );
  return cudaDir;
}
