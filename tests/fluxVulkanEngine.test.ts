import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareFluxInpaintingEngine } from "../src/main/inpainting";
import {
  FLUX_MODEL_FILE,
  FLUX_SDCPP_LLM_FILE,
  FLUX_VAE_FILE,
} from "../src/main/inpainting/fluxAssets/constants";

vi.mock("../src/main/runtimeSupport/nativeInferenceLaunch", () => ({
  prepareNativeInferenceLaunch: async () => ({
    executable: "mgt-flux-klein-vulkan.exe",
    manifest: "diffusion-runtime.json",
    env: {},
  }),
}));
vi.mock("../src/main/runtimeSupport/modelDownloads", async (original) => ({
  ...(await original<
    typeof import("../src/main/runtimeSupport/modelDownloads")
  >()),
  ensureRemoteFile: async (file: { modelDir: string; fileName: string }) =>
    join(file.modelDir, file.fileName),
}));
vi.mock("electron", async () => ({
  app: { isPackaged: false },
  nativeImage: (await import("./mcpImageNative.fixture")).imageNativeBoundary,
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(() => {
    throw new Error("captured worker spawn");
  }),
}));

afterEach(() => vi.unstubAllEnvs());

describe("FLUX Vulkan app entry point", () => {
  it("passes all verified model paths to the native worker along with its manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "flux-vulkan-app-"));
    const modelDir = join(root, "경로 with spaces", "models");
    vi.stubEnv("MANGA_TRANSLATOR_LOG_PATH", join(root, "app.log"));
    const engine = await prepareFluxInpaintingEngine({
      runtimeDir: root,
      modelDir,
      fluxBackend: "vulkan-native",
    });
    try {
      const mask = new Uint8Array(64 * 64).fill(255);
      await expect(
        engine.inpaint(Buffer.alloc(mask.length * 4), 64, 64, mask, [
          { x: 0, y: 0, w: 64, h: 64 },
        ]),
      ).rejects.toThrow("captured worker spawn");
      const call = vi.mocked(spawn).mock.lastCall;
      expect(call?.[0]).toBe("mgt-flux-klein-vulkan.exe");
      const args = Array.isArray(call?.[1]) ? call[1] : [];
      for (const [flag, path] of [
        ["--native-runtime", "diffusion-runtime.json"],
        ["--transformer-path", join(modelDir, FLUX_MODEL_FILE)],
        ["--vae-path", join(modelDir, FLUX_VAE_FILE)],
        ["--text-encoder-path", join(modelDir, FLUX_SDCPP_LLM_FILE)],
      ]) {
        expect(args).toContain(flag);
        expect(args[args.indexOf(flag) + 1]).toBe(path);
      }
    } finally {
      await engine.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
