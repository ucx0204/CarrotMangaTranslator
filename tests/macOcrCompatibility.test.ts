import { describe, expect, it } from "vitest";
import {
  buildBaseTranslationOptions,
  parseStoredAppSettings,
  resolveDefaultAppSettings,
} from "../src/main/appSettings";

describe("Apple Silicon OCR compatibility", () => {
  it("uses economy as the lowest recommended mode for 16 GiB Japanese OCR", () => {
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

    const options = buildMacTranslationOptions(settings, "mac-economy-ocr");

    expect(options).toMatchObject({
      sourceLanguage: "ja",
      ocrDevice: "cpu",
      ocrQualityMode: "economy",
      ocrBboxMode: "ocr",
      ocrEngine: "paddle_static",
      ocrVersion: "PP-OCRv6",
      ocrTextDetectionModelName: "PP-OCRv6_small_det",
      ocrTextRecognitionModelName: "PP-OCRv6_small_rec",
    });
  });

  it("keeps the economy recognizer for a supported non-Japanese language", () => {
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
      buildMacTranslationOptions(settings, "mac-economy-english-ocr"),
    ).toMatchObject({
      sourceLanguage: "en",
      ocrTextRecognitionModelName: "PP-OCRv6_small_rec",
    });
  });

  it("preserves an explicit legacy GPU route instead of silently selecting CPU", () => {
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
      device: "gpu",
      gpuBackend: "cuda",
      qualityMode: "full",
    });

    const options = buildMacTranslationOptions(settings, "mac-legacy-ocr");

    expect(options).toMatchObject({
      ocrDevice: "gpu",
      ocrGpuBackend: "cuda",
      ocrQualityMode: "full",
      ocrBboxMode: "ocr",
      ocrEngine: "transformers",
      ocrVersion: "PP-OCRv6",
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
