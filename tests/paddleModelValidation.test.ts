import { describe, expect, it } from "vitest";

const {
  isPaddleOcrModelAssetLoadFailure,
  resolvePaddleOcrModelNamesForRepair,
} = require("../src/main/runtime/model/paddle-model-validation.cjs") as {
  isPaddleOcrModelAssetLoadFailure: (value: unknown) => boolean;
  resolvePaddleOcrModelNamesForRepair: (
    reason?: unknown,
    options?: Record<string, unknown>,
  ) => string[];
};

describe("Paddle OCR model failure classification", () => {
  it("does not treat normal model startup followed by an import failure as cache corruption", () => {
    const error = {
      stderrPreview: [
        "Creating model: ('PP-OCRv6_medium_det', None, None)",
        "Could not import module 'AutoImageProcessor'. Are this object's requirements defined correctly?",
      ].join("\n"),
    };

    expect(isPaddleOcrModelAssetLoadFailure(error)).toBe(false);
  });

  it("recognizes actual JSON and empty-model parse failures", () => {
    expect(
      isPaddleOcrModelAssetLoadFailure(
        "nlohmann::json::exception::parse_error.101: parse error",
      ),
    ).toBe(true);
    expect(
      isPaddleOcrModelAssetLoadFailure({
        message: "Creating model: ('PP-OCRv6_medium_det', None, None)",
        cause:
          "json.exception.parse_error.101: attempting to parse an empty input",
      }),
    ).toBe(true);
  });

  it("targets the separate safetensors caches for Transformers OCR repair", () => {
    const cudaOptions = {
      ocrDevice: "gpu",
      ocrGpuBackend: "cuda",
      ocrEngine: "transformers",
    };

    expect(resolvePaddleOcrModelNamesForRepair("", cudaOptions)).toEqual([
      "PP-OCRv6_medium_det_safetensors",
      "PP-OCRv6_medium_rec_safetensors",
    ]);
    expect(
      resolvePaddleOcrModelNamesForRepair("PP-OCRv6_small_rec failed", {
        ...cudaOptions,
        sourceLanguage: "ja",
        ocrTextDetectionModelName: "PP-OCRv6_small_det",
        ocrTextRecognitionModelName: "PP-OCRv6_small_rec",
      }),
    ).toEqual(["PP-OCRv6_small_rec_safetensors"]);
  });

  it.each([
    [
      "ko",
      [
        "PP-OCRv5_server_det_safetensors",
        "korean_PP-OCRv5_mobile_rec_safetensors",
      ],
    ],
    [
      "ka",
      ["PP-OCRv3_mobile_det_safetensors", "ka_PP-OCRv3_mobile_rec_safetensors"],
    ],
  ])(
    "ignores injected low-mode PP-OCRv6 names when %s forces an older OCR version",
    (sourceLanguage, expectedCaches) => {
      expect(
        resolvePaddleOcrModelNamesForRepair("", {
          ocrDevice: "gpu",
          ocrGpuBackend: "rocm-transformers",
          ocrEngine: "transformers",
          sourceLanguage,
          ocrVersion: "PP-OCRv6",
          ocrTextDetectionModelName: "PP-OCRv6_small_det",
          ocrTextRecognitionModelName: "PP-OCRv6_tiny_rec",
        }),
      ).toEqual(expectedCaches);
    },
  );

  it("preserves explicit non-v6 custom models for a forced v5 language", () => {
    expect(
      resolvePaddleOcrModelNamesForRepair("custom-v5-rec failed", {
        ocrDevice: "gpu",
        ocrGpuBackend: "cuda",
        ocrEngine: "transformers",
        sourceLanguage: "ko",
        ocrTextDetectionModelName: "custom-v5-det",
        ocrTextRecognitionModelName: "custom-v5-rec",
      }),
    ).toEqual(["custom-v5-rec_safetensors"]);
  });

  it.each([
    ["ko", "korean_PP-OCRv5_mobile_rec_safetensors"],
    ["th", "th_PP-OCRv5_mobile_rec_safetensors"],
    ["ar", "arabic_PP-OCRv5_mobile_rec_safetensors"],
    ["ru", "eslav_PP-OCRv5_mobile_rec_safetensors"],
    ["hi", "devanagari_PP-OCRv5_mobile_rec_safetensors"],
  ])(
    "targets the language-specific PP-OCRv5 Transformers caches for %s",
    (sourceLanguage, recognitionCache) => {
      expect(
        resolvePaddleOcrModelNamesForRepair("", {
          ocrDevice: "gpu",
          ocrGpuBackend: "cuda",
          ocrEngine: "transformers",
          sourceLanguage,
          ocrVersion: "PP-OCRv6",
        }),
      ).toEqual(["PP-OCRv5_server_det_safetensors", recognitionCache]);
    },
  );

  it("targets the forced Georgian PP-OCRv3 Transformers caches", () => {
    expect(
      resolvePaddleOcrModelNamesForRepair("", {
        ocrDevice: "gpu",
        ocrGpuBackend: "rocm-transformers",
        ocrEngine: "transformers",
        sourceLanguage: "ka-GE",
        ocrVersion: "PP-OCRv6",
      }),
    ).toEqual([
      "PP-OCRv3_mobile_det_safetensors",
      "ka_PP-OCRv3_mobile_rec_safetensors",
    ]);
  });

  it("preserves static repair names for CPU AMD settings", () => {
    expect(
      resolvePaddleOcrModelNamesForRepair("PP-OCRv6_medium_det failed", {
        ocrDevice: "cpu",
        ocrGpuBackend: "rocm-transformers",
        ocrEngine: "paddle_static",
      }),
    ).toEqual(["PP-OCRv6_medium_det"]);
  });
});
