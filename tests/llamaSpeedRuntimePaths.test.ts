import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
  GEMMA_12B_QAT_MODEL_REPO,
  GEMMA_26B_MODEL_FILE_IQ3_S,
  GEMMA_26B_MODEL_REPO,
  GEMMA_26B_QAT_MODEL_FILE_Q4_K_M,
  GEMMA_26B_QAT_MODEL_REPO,
  GEMMA_31B_QAT_MODEL_FILE_Q4_K_M,
  GEMMA_31B_QAT_MODEL_REPO,
} from "../src/shared/modelPresets";

const require = createRequire(import.meta.url);
const { resolvePreferredLlamaRuntime } =
  require("../src/main/runtime/simple-page-runtime-paths.cjs") as {
    resolvePreferredLlamaRuntime: (options?: Record<string, unknown>) => {
      id: string;
      kind: string;
      archives: Array<{ sha256?: string; expectedBytes?: number }>;
    };
  };
const {
  resolveWindowsLlamaRuntimeMaxRelativePathLength,
  shouldExtractLlamaRuntimeFile,
} = require("../src/main/runtime/simple-page-llama-runtimes.cjs") as {
  resolveWindowsLlamaRuntimeMaxRelativePathLength: (
    runtime?: {
      id?: string;
      requiredFiles?: Array<string | string[]>;
    } | null,
  ) => number;
  shouldExtractLlamaRuntimeFile: (
    fileName: string,
    relativePath?: string,
  ) => boolean;
};

describe("llama speed runtime path selection", () => {
  it("routes the QAT 31B MTP preset through current speed runtimes", () => {
    const cuda = resolvePreferredLlamaRuntime({
      llamaRuntimeProfile: "cuda12",
      modelRepo: GEMMA_31B_QAT_MODEL_REPO,
      modelFile: GEMMA_31B_QAT_MODEL_FILE_Q4_K_M,
    });
    expect(cuda.id).toBe("llama-b10621-cuda12.4");
    expect(cuda.kind).toBe("mainline");

    const rocm = resolvePreferredLlamaRuntime({
      llamaRuntimeProfile: "rocm",
      llamaRocmTarget: "gfx110X",
      modelRepo: GEMMA_31B_QAT_MODEL_REPO,
      modelFile: GEMMA_31B_QAT_MODEL_FILE_Q4_K_M,
    });
    expect(rocm.id).toBe("lemonade-llama-b1317-rocm-gfx110X");
    expect(rocm.archives[0]).toMatchObject({
      sha256:
        "dbbca4f3b631ed29ad26395c965c899ef256d2031daf24c193145113c00b6390",
      expectedBytes: 163_321_007,
    });
  });

  it("routes every QAT speed size to b10621 while preserving legacy", () => {
    for (const [modelRepo, modelFile] of [
      [GEMMA_12B_QAT_MODEL_REPO, GEMMA_12B_QAT_MODEL_FILE_Q4_K_M],
      [GEMMA_26B_QAT_MODEL_REPO, GEMMA_26B_QAT_MODEL_FILE_Q4_K_M],
      [GEMMA_31B_QAT_MODEL_REPO, GEMMA_31B_QAT_MODEL_FILE_Q4_K_M],
    ]) {
      expect(
        resolvePreferredLlamaRuntime({
          llamaRuntimeProfile: "cuda13",
          modelRepo,
          modelFile,
        }).id,
      ).toBe("llama-b10621-cuda13.3");
      expect(
        resolvePreferredLlamaRuntime({
          llamaRuntimeProfile: "vulkan",
          modelRepo,
          modelFile,
        }).id,
      ).toBe("llama-b10621-vulkan");
    }

    expect(
      resolvePreferredLlamaRuntime({
        llamaRuntimeProfile: "cuda12",
        modelRepo: GEMMA_26B_MODEL_REPO,
        modelFile: GEMMA_26B_MODEL_FILE_IQ3_S,
      }).id,
    ).toBe("llama-b9553-cuda12.4");
  });

  it("keeps extraction and fallback path policies explicit", () => {
    expect(
      shouldExtractLlamaRuntimeFile(
        "TensileLibrary.dat",
        "rocblas/library/TensileLibrary.dat",
      ),
    ).toBe(true);
    expect(
      shouldExtractLlamaRuntimeFile("kernel.co", "hipblaslt/library/kernel.co"),
    ).toBe(true);
    expect(
      shouldExtractLlamaRuntimeFile("README.txt", "rocblas/README.txt"),
    ).toBe(false);
    expect(shouldExtractLlamaRuntimeFile("ggml-cuda.dll")).toBe(true);
    expect(shouldExtractLlamaRuntimeFile("llama-server.exe")).toBe(true);
    expect(shouldExtractLlamaRuntimeFile("notes.txt")).toBe(false);

    expect(
      resolveWindowsLlamaRuntimeMaxRelativePathLength({
        id: "unlisted-runtime",
        requiredFiles: ["llama-server.exe", ["nested-runtime-library.dll"]],
      }),
    ).toBe(255);
    expect(resolveWindowsLlamaRuntimeMaxRelativePathLength(null)).toBe(255);
  });

  it.each([
    ["gfx103X", 102],
    ["gfx110X", 122],
    ["gfx1150", 122],
    ["gfx1151", 122],
    ["gfx120X", 134],
    ["gfx908", 121],
    ["gfx90a", 137],
  ])("pins the audited b1317 path budget for %s", (target, maximum) => {
    expect(
      resolveWindowsLlamaRuntimeMaxRelativePathLength({
        id: `lemonade-llama-b1317-rocm-${target}`,
      }),
    ).toBe(maximum);
  });
});
