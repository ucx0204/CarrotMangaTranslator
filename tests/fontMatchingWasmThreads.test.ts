import { describe, expect, it } from "vitest";
import {
  nativeGpuSessionOptions,
  resolveFontMatchingExecutionBackend,
  resolveFontMatchingWasmThreads,
  wasmSessionOptions,
} from "../src/main/pipeline/fontMatchingPagePixelInference";

describe("font matching WASM thread routing", () => {
  it.each([
    [1, 1],
    [2, 1],
    [4, 2],
    [8, 4],
    [16, 8],
    [64, 8],
  ])(
    "uses at most half of %i logical processors with an eight-thread cap",
    (logical, expected) => {
      expect(resolveFontMatchingWasmThreads({}, logical)).toBe(expected);
    },
  );

  it("accepts bounded diagnostic overrides and rejects unsafe values", () => {
    expect(
      resolveFontMatchingWasmThreads(
        { MANGA_TRANSLATOR_FONT_MATCHING_THREADS: "8" },
        4,
      ),
    ).toBe(8);
    for (const value of ["0", "9", "2.5", "invalid"]) {
      expect(
        resolveFontMatchingWasmThreads(
          { MANGA_TRANSLATOR_FONT_MATCHING_THREADS: value },
          8,
        ),
      ).toBe(4);
    }
  });

  it("uses DirectML by default on Windows with explicit portable overrides", () => {
    expect(resolveFontMatchingExecutionBackend({}, "win32")).toBe("dml");
    expect(resolveFontMatchingExecutionBackend({}, "darwin")).toBe("wasm");
    expect(
      resolveFontMatchingExecutionBackend(
        { MANGA_TRANSLATOR_FONT_MATCHING_BACKEND: "wasm" },
        "win32",
      ),
    ).toBe("wasm");
    expect(
      resolveFontMatchingExecutionBackend(
        { MANGA_TRANSLATOR_FONT_MATCHING_BACKEND: "webgpu" },
        "linux",
      ),
    ).toBe("webgpu");
    expect(
      resolveFontMatchingExecutionBackend(
        { MANGA_TRANSLATOR_FONT_MATCHING_BACKEND: "dml" },
        "darwin",
      ),
    ).toBe("wasm");
  });

  it("uses sequential bounded-memory sessions for portable and native GPU backends", () => {
    expect(wasmSessionOptions()).toEqual({
      executionProviders: ["wasm"],
      executionMode: "sequential",
      graphOptimizationLevel: "all",
    });
    expect(nativeGpuSessionOptions("dml")).toEqual({
      executionProviders: ["dml"],
      executionMode: "sequential",
      enableMemPattern: false,
      graphOptimizationLevel: "all",
    });
    expect(nativeGpuSessionOptions("webgpu")).toEqual({
      executionProviders: ["webgpu"],
      executionMode: "sequential",
      enableMemPattern: false,
      graphOptimizationLevel: "all",
    });
  });
});
