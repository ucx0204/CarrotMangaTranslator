import { describe, expect, it } from "vitest";
import {
  AmdRocmTargetSchema,
  FluxBackendSchema,
  GemmaVramModeSchema,
  InpaintingModelSchema,
  KoharuInpaintingBackendSchema,
  LlamaRuntimeProfileSchema,
  OcrGpuBackendSchema,
  OcrQualityModeSchema,
} from "../src/shared/ipcEnumSchemas";
import {
  resolveFluxBackend,
  resolveGemmaVramMode,
  resolveInpaintingModel,
  resolveKoharuInpaintingBackend,
  resolveOcrGpuBackend,
  resolveOcrQualityMode,
  resolveOptionalJsonObjectString,
} from "../src/main/settings/appSettingsResolvers";
import { normalizeAmdRocmTarget } from "../src/main/gpuInfo";
import { resolveLlamaRuntimeProfile } from "../src/main/settings/llamaRuntimeProfile";

describe("settings alias surfaces", () => {
  it("keeps Gemma aliases identical", () => {
    assertAliasMatrix(
      [
        ["minimum12b", ["minimum12b", "minimum", "minimal", "min", "12b"]],
        ["economy26b", ["economy26b", "economy", "eco", "26b"]],
        ["full31b", ["full31b", "full", "31b"]],
      ],
      (alias) => GemmaVramModeSchema.parse(alias),
      (alias) => resolveGemmaVramMode(alias, "full31b"),
    );
  });

  it("keeps Llama aliases identical", () => {
    assertAliasMatrix(
      [
        ["rtx50", ["rtx50", "blackwell", "cuda13", "cuda13.1", "cuda13.3"]],
        ["cuda12", ["cuda12", "cuda12.4", "cuda"]],
        ["rocm", ["rocm", "hip", "amd-rocm"]],
        ["vulkan", ["vulkan", "amd-vulkan", "vk"]],
        ["metal", ["metal", "apple", "apple-metal", "mps"]],
      ],
      (alias) => LlamaRuntimeProfileSchema.parse(alias),
      (alias) => resolveLlamaRuntimeProfile({}, alias),
    );
  });

  it("keeps ROCm target aliases identical", () => {
    assertAliasMatrix(
      [
        ["gfx908", ["gfx908"]],
        ["gfx90a", ["gfx90a"]],
        ["gfx103X", ["gfx1030", "gfx103X"]],
        ["gfx110X", ["gfx-1100", "gfx1103"]],
        ["gfx1150", ["gfx1150"]],
        ["gfx1151", ["gfx1151"]],
        ["gfx120X", ["gfx 1201"]],
      ],
      (alias) => AmdRocmTargetSchema.parse(alias),
      normalizeAmdRocmTarget,
    );
  });

  it("keeps shared Flux aliases identical", () => {
    assertAliasMatrix(
      [
        ["cuda-native", ["cuda-native", "cuda", "native", "nvidia"]],
        [
          "cuda-sm75-experimental",
          ["cuda-sm75-experimental", "cuda-sm75", "sm75-cuda", "sm75"],
        ],
        [
          "zluda-native",
          ["zluda-native", "zluda", "python-rocm", "rocm", "hip", "amd"],
        ],
        ["metal-native", ["metal-native", "metal", "apple"]],
        ["python-cpu", ["python-cpu", "cpu"]],
      ],
      (alias) => FluxBackendSchema.parse(alias),
      (alias) => resolveFluxBackend(alias, "python-cpu"),
    );
  });

  it("keeps IPC-only Flux aliases out of stored settings", () => {
    for (const alias of ["", "auto"]) {
      expect(FluxBackendSchema.parse(alias)).toBe("cuda-native");
      expect(resolveFluxBackend(alias, "python-cpu")).toBe("python-cpu");
    }
    for (const alias of ["apple-metal", "mps"]) {
      expect(FluxBackendSchema.parse(alias)).toBe("metal-native");
      expect(resolveFluxBackend(alias, "python-cpu")).toBe("python-cpu");
    }
  });

  it("keeps inpainting-model aliases surface-compatible", () => {
    assertAliasMatrix(
      [
        ["flux-klein", ["flux", "flux-klein", "klein", "default"]],
        ["lama-manga", ["koharu", "lama", "lama-manga", "lama_manga"]],
        ["aot-inpainting", ["aot", "aot-inpainting", "aot_inpainting"]],
      ],
      (alias) => InpaintingModelSchema.parse(alias),
      (alias) => resolveInpaintingModel(alias, "aot-inpainting"),
    );
    for (const alias of ["", "auto"]) {
      expect(InpaintingModelSchema.parse(alias)).toBe("flux-klein");
      expect(resolveInpaintingModel(alias, "aot-inpainting")).toBe(
        "aot-inpainting",
      );
    }
  });

  it("keeps Koharu aliases surface-compatible", () => {
    assertAliasMatrix(
      [
        ["auto", ["auto", "default"]],
        ["cuda-native", ["cuda", "cuda-native", "nvidia"]],
        ["zluda-native", ["zluda", "zluda-native", "amd"]],
        ["metal-native", ["metal", "metal-native", "apple"]],
        ["cpu", ["cpu", "python-cpu"]],
      ],
      (alias) => KoharuInpaintingBackendSchema.parse(alias),
      (alias) => resolveKoharuInpaintingBackend(alias, "cpu"),
    );
    for (const [alias, ipcExpected] of [
      ["", "auto"],
      ["apple-metal", "metal-native"],
      ["mps", "metal-native"],
    ]) {
      expect(KoharuInpaintingBackendSchema.parse(alias)).toBe(ipcExpected);
      expect(resolveKoharuInpaintingBackend(alias, "cpu")).toBe("cpu");
    }
  });

  it("keeps OCR GPU aliases surface-compatible", () => {
    assertAliasMatrix(
      [
        ["cuda", ["cuda", "nvidia"]],
        [
          "rocm-transformers",
          ["rocm", "amd", "hip", "rocm-transformers", "transformers-rocm"],
        ],
      ],
      (alias) => OcrGpuBackendSchema.parse(alias),
      (alias) => resolveOcrGpuBackend(alias, "rocm-transformers"),
    );
    for (const alias of ["", "auto"]) {
      expect(OcrGpuBackendSchema.parse(alias)).toBe("cuda");
      expect(resolveOcrGpuBackend(alias, "rocm-transformers")).toBe(
        "rocm-transformers",
      );
    }
  });

  it("keeps OCR quality aliases identical", () => {
    assertAliasMatrix(
      [
        [
          "economy",
          [
            "minimum",
            "minimal",
            "min",
            "tiny",
            "tiny_rec",
            "tiny-rec",
            "12b",
            "최소",
            "economy",
            "eco",
            "small",
            "small_rec",
            "small-rec",
            "26b",
            "절약",
          ],
        ],
        [
          "full",
          [
            "full",
            "quality",
            "31b",
            "풀로드",
            "cuda-legacy-full",
            "cuda_legacy_full",
            "cuda-legacy",
            "legacy-full",
            "legacy",
            "vl",
            "paddleocr-vl",
            "cuda 레거시 풀로드",
          ],
        ],
      ],
      (alias) => OcrQualityModeSchema.parse(alias),
      (alias) => resolveOcrQualityMode(alias, "full"),
    );
  });

  it("accepts only optional JSON objects without changing fallback ownership", () => {
    expect(resolveOptionalJsonObjectString(undefined, "fallback")).toBe(
      "fallback",
    );
    expect(resolveOptionalJsonObjectString(null, "fallback")).toBe("");
    expect(resolveOptionalJsonObjectString("  ", "fallback")).toBe("");
    expect(resolveOptionalJsonObjectString('{"X-Trace":"value"}')).toBe(
      '{"X-Trace":"value"}',
    );
    expect(resolveOptionalJsonObjectString("[]", "fallback")).toBe("fallback");
    expect(resolveOptionalJsonObjectString("{", "fallback")).toBe("fallback");
  });

  it("preserves invalid-value behavior on each surface", () => {
    const invalid = "not-a-supported-setting";
    expect(
      [
        GemmaVramModeSchema,
        LlamaRuntimeProfileSchema,
        AmdRocmTargetSchema,
        FluxBackendSchema,
        InpaintingModelSchema,
        KoharuInpaintingBackendSchema,
        OcrGpuBackendSchema,
        OcrQualityModeSchema,
      ].every((schema) => !schema.safeParse(invalid).success),
    ).toBe(true);
    expect(resolveFluxBackend(invalid, "python-cpu")).toBe("python-cpu");
    expect(resolveInpaintingModel(invalid, "aot-inpainting")).toBe(
      "aot-inpainting",
    );
    expect(resolveKoharuInpaintingBackend(invalid, "cpu")).toBe("cpu");
    expect(resolveOcrGpuBackend(invalid, "rocm-transformers")).toBe(
      "rocm-transformers",
    );
    expect(resolveOcrQualityMode(invalid, "economy")).toBe("economy");
    expect(resolveLlamaRuntimeProfile({}, invalid)).toBe("cuda12");
    expect(normalizeAmdRocmTarget(invalid)).toBeNull();
    expect(GemmaVramModeSchema.safeParse("").success).toBe(false);
    expect(resolveGemmaVramMode("", "economy26b")).toBe("economy26b");
  });
});

function assertAliasMatrix(
  groups: ReadonlyArray<readonly [string, readonly string[]]>,
  parseIpc: (alias: string) => unknown,
  resolveStored: (alias: string) => unknown,
): void {
  for (const [expected, aliases] of groups) {
    for (const alias of aliases) {
      expect(parseIpc(alias)).toBe(expected);
      expect(resolveStored(alias)).toBe(expected);
    }
  }
}
