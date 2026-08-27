import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import { resolveDefaultLlamaServerPathForGemma } from "../src/main/settings/translationLlamaServerPath";
import {
  GEMMA_12B_MODEL_FILE_Q4_K_M,
  GEMMA_12B_MODEL_REPO,
  GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
  GEMMA_12B_QAT_MODEL_REPO,
  GEMMA_26B_MODEL_FILE_IQ3_S,
  GEMMA_26B_MODEL_REPO,
  GEMMA_31B_MODEL_FILE_IQ3_S,
  GEMMA_31B_MODEL_REPO,
} from "../src/shared/modelPresets";

const paths = {
  dataRoot: "C:/app-data",
  toolsDir: "C:/bundled-tools",
  llamaServerPath: "D:/custom/llama-server.exe",
};
const binaryName =
  process.platform === "win32" ? "llama-server.exe" : "llama-server";

describe("speed llama server path selection", () => {
  it.each([
    ["cuda12", "llama-b10621-cuda12.4", paths.dataRoot],
    ["cuda13", "llama-b10621-cuda13.3", paths.dataRoot],
    ["vulkan", "llama-b10621-vulkan", paths.dataRoot],
    ["metal", "llama-b10621-metal-arm64", paths.toolsDir],
  ])("routes QAT speed models on %s through %s", (profile, directory, root) => {
    const defaults = resolveDefaultAppSettings();
    const gemma = {
      ...defaults.gemma,
      modelSource: "huggingface" as const,
      modelRepo: GEMMA_12B_QAT_MODEL_REPO,
      modelFile: GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
    };

    expect(resolveDefaultLlamaServerPathForGemma(paths, gemma, profile)).toBe(
      root === paths.dataRoot
        ? join(root, "tools", directory, binaryName)
        : join(root, directory, binaryName),
    );
  });

  it("routes speed and legacy ROCm releases independently", () => {
    const defaults = resolveDefaultAppSettings();
    const speed = {
      ...defaults.gemma,
      modelSource: "huggingface" as const,
      modelRepo: GEMMA_12B_QAT_MODEL_REPO,
      modelFile: GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
    };
    const legacy = {
      ...speed,
      modelRepo: GEMMA_26B_MODEL_REPO,
      modelFile: GEMMA_26B_MODEL_FILE_IQ3_S,
    };

    expect(
      resolveDefaultLlamaServerPathForGemma(paths, speed, "rocm", "gfx110X"),
    ).toBe(
      join(
        paths.dataRoot,
        "tools",
        "lemonade-llama-b1317-rocm-gfx110X",
        binaryName,
      ),
    );
    expect(resolveDefaultLlamaServerPathForGemma(paths, legacy, "rocm")).toBe(
      join(
        paths.dataRoot,
        "tools",
        "lemonade-llama-b1291-rocm-unknown",
        binaryName,
      ),
    );
  });

  it("preserves every legacy CUDA, Vulkan, Metal, and 31B HIP route", () => {
    const defaults = resolveDefaultAppSettings();
    const legacy12 = {
      ...defaults.gemma,
      modelSource: "huggingface" as const,
      modelRepo: GEMMA_12B_MODEL_REPO,
      modelFile: GEMMA_12B_MODEL_FILE_Q4_K_M,
    };
    const legacy31 = {
      ...legacy12,
      modelRepo: GEMMA_31B_MODEL_REPO,
      modelFile: GEMMA_31B_MODEL_FILE_IQ3_S,
    };

    expect(
      resolveDefaultLlamaServerPathForGemma(paths, legacy12, "cuda12"),
    ).toContain("llama-b9553-cuda12.4");
    expect(
      resolveDefaultLlamaServerPathForGemma(paths, legacy12, "cuda13"),
    ).toContain("llama-b9553-cuda13.3");
    expect(
      resolveDefaultLlamaServerPathForGemma(paths, legacy12, "vulkan"),
    ).toContain("llama-b9547-vulkan");
    expect(
      resolveDefaultLlamaServerPathForGemma(paths, legacy12, "metal"),
    ).toContain("llama-b9547-metal-arm64");
    expect(
      resolveDefaultLlamaServerPathForGemma(paths, legacy31, "metal"),
    ).toContain("beellama-v0.3.1-metal-arm64");
    expect(
      resolveDefaultLlamaServerPathForGemma(paths, legacy31, "rocm"),
    ).toContain("beellama-v0.3.1-hip-radeon");
  });

  it("keeps custom Hugging Face models on the explicitly selected server", () => {
    const defaults = resolveDefaultAppSettings();
    expect(
      resolveDefaultLlamaServerPathForGemma(paths, {
        ...defaults.gemma,
        modelSource: "huggingface",
        modelRepo: "custom/model",
        modelFile: "custom.gguf",
      }),
    ).toBe(paths.llamaServerPath);
  });
});
