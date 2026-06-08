import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { resolvePreferredLlamaRuntime } = require("../src/main/runtime/simple-page-runtime-paths.cjs") as {
  resolvePreferredLlamaRuntime: (options?: Record<string, unknown>) => {
    id: string;
    dir: string;
    archive: string;
    url: string;
    backend: string;
  };
};

describe("llama runtime path selection", () => {
  it("selects the matching Lemonade ROCm runtime for a known AMD target", () => {
    const runtime = resolvePreferredLlamaRuntime({
      llamaRuntimeProfile: "rocm",
      llamaRocmTarget: "gfx1201"
    });

    expect(runtime.backend).toBe("rocm");
    expect(runtime.id).toBe("lemonade-llama-b1291-rocm-gfx120X");
    expect(runtime.dir).toBe("lemonade-llama-b1291-rocm-gfx120X");
    expect(runtime.archive).toBe("llama-b1291-windows-rocm-gfx120X-x64.zip");
    expect(runtime.url).toContain("lemonade-sdk/llamacpp-rocm/releases/download/b1291/");
  });

  it("does not guess an AMD ROCm runtime when the GPU target is unknown", () => {
    expect(() => resolvePreferredLlamaRuntime({ llamaRuntimeProfile: "rocm" })).toThrow(/AMD GPU/);
  });
});
