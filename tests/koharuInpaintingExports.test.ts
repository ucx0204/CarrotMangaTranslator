import { describe, expect, it, vi } from "vitest";
import { resolveKoharuModelFiles } from "../src/main/inpainting/koharuAssets";

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
});
