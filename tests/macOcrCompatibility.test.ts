import { describe, expect, it } from "vitest";
import {
  buildBaseTranslationOptions,
  parseStoredAppSettings,
  resolveDefaultAppSettings,
} from "../src/main/appSettings";

describe("Apple Silicon OCR compatibility", () => {
  it("keeps the 16 GiB Japanese default off the unsupported tiny recognizer", () => {
    const settings = resolveDefaultAppSettings(
      {},
      {
        name: "Apple M2 Pro",
        memoryMb: 16 * 1024,
        unifiedMemoryMb: 16 * 1024,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "apple",
        supportsMetal: true,
      },
    );

    const options = buildMacTranslationOptions(settings, "mac-minimum-ocr");

    expect(options).toMatchObject({
      sourceLanguage: "ja",
      ocrDevice: "cpu",
      ocrQualityMode: "minimum",
      ocrBboxMode: "ocr",
      ocrEngine: "paddle_static",
      ocrVersion: "PP-OCRv6",
      ocrTextDetectionModelName: "PP-OCRv6_small_det",
      ocrTextRecognitionModelName: "PP-OCRv6_small_rec",
    });
  });

  it("retains the tiny recognizer for a supported non-Japanese language", () => {
    const defaults = resolveDefaultAppSettings(
      {},
      {
        name: "Apple M2 Pro",
        memoryMb: 16 * 1024,
        unifiedMemoryMb: 16 * 1024,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "apple",
        supportsMetal: true,
      },
    );
    const settings = parseStoredAppSettings(
      JSON.stringify({ translation: { sourceLanguage: "en" } }),
      defaults,
    );

    expect(
      buildMacTranslationOptions(settings, "mac-minimum-english-ocr"),
    ).toMatchObject({
      sourceLanguage: "en",
      ocrTextRecognitionModelName: "PP-OCRv6_tiny_rec",
    });
  });

  it("migrates legacy Metal/VL preferences onto the PP-OCRv6 CPU route", () => {
    const defaults = resolveDefaultAppSettings(
      {},
      {
        name: "Apple M4 Pro",
        memoryMb: 32 * 1024,
        unifiedMemoryMb: 32 * 1024,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "apple",
        supportsMetal: true,
      },
    );
    const settings = parseStoredAppSettings(
      JSON.stringify({
        ocr: {
          device: "gpu",
          gpuBackend: "cuda",
          qualityMode: "cuda-legacy-full",
        },
      }),
      defaults,
    );

    expect(settings.ocr).toMatchObject({
      device: "cpu",
      gpuBackend: "cuda",
      qualityMode: "economy",
    });

    const options = buildMacTranslationOptions(settings, "mac-legacy-ocr");

    expect(options).toMatchObject({
      ocrDevice: "cpu",
      ocrBboxMode: "ocr",
      ocrEngine: "paddle_static",
      ocrVersion: "PP-OCRv6",
      ocrTextDetectionModelName: "PP-OCRv6_small_det",
      ocrTextRecognitionModelName: "PP-OCRv6_small_rec",
      ocrMergeMode: "semantic",
    });
  });
});

function buildMacTranslationOptions(
  settings: ReturnType<typeof resolveDefaultAppSettings>,
  jobId: string,
) {
  return buildBaseTranslationOptions({
    jobId,
    runDir: `/tmp/${jobId}`,
    paths: {
      dataRoot: "/tmp/app-data",
      toolsDir:
        "/Applications/CarrotMangaTranslator.app/Contents/Resources/tools",
      llamaServerPath:
        "/Applications/CarrotMangaTranslator.app/Contents/Resources/tools/llama-b9547-metal-arm64/llama-server",
      hfHomeDir: "/tmp/hf-home",
      hfHubCacheDir: "/tmp/hf-home/hub",
    },
    settings,
    env: {},
  });
}
