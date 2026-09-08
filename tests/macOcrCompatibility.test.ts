import { describe, expect, it } from "vitest";
import {
  buildBaseTranslationOptions,
  parseStoredAppSettings,
  resolveDefaultAppSettings,
} from "../src/main/appSettings";

describe("Apple Silicon OCR compatibility", () => {
  it.each([
    { label: "new settings", stored: undefined },
    { label: "missing OCR settings", stored: "{}" },
    {
      label: "missing OCR pipeline",
      stored: JSON.stringify({ ocr: { device: "cpu" } }),
    },
  ])("uses Hayai CPU for $label on 16 GiB Apple Silicon", ({ stored }) => {
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
    const settings = parseStoredAppSettings(stored, defaults);
    const options = buildMacTranslationOptions(settings, "mac-hayai-cpu");

    expect(settings.ocr).toMatchObject({
      pipeline: "hayai",
      device: "cpu",
      qualityMode: "economy",
    });
    expect(options).toMatchObject({
      sourceLanguage: "ja",
      ocrPipeline: "hayai",
      ocrDevice: "cpu",
      ocrQualityMode: "economy",
      ocrBboxProvider: "hayai-regions",
    });
    expect(options.ocrBboxMode).toBeUndefined();
    expect(options.ocrEngine).toBeUndefined();
    expect(options.ocrVersion).toBeUndefined();
    expect(options.ocrTextDetectionModelName).toBeUndefined();
    expect(options.ocrTextRecognitionModelName).toBeUndefined();
  });

  it("preserves saved Paddle economy mode for 16 GiB Japanese OCR", () => {
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
      JSON.stringify({ ocr: { pipeline: "paddle-legacy" } }),
      defaults,
    );

    const options = buildMacTranslationOptions(settings, "mac-economy-ocr");

    expect(settings.ocr.pipeline).toBe("paddle-legacy");
    expect(options).toMatchObject({
      sourceLanguage: "ja",
      ocrPipeline: "paddle-legacy",
      ocrBboxProvider: "paddleocr",
      ocrDevice: "cpu",
      ocrQualityMode: "economy",
      ocrBboxMode: "ocr",
      ocrEngine: "paddle_static",
      ocrVersion: "PP-OCRv6",
      ocrTextDetectionModelName: "PP-OCRv6_small_det",
      ocrTextRecognitionModelName: "PP-OCRv6_small_rec",
    });
  });

  it("keeps the saved Paddle economy recognizer for a supported non-Japanese language", () => {
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
      JSON.stringify({
        translation: { sourceLanguage: "en" },
        ocr: { pipeline: "paddle-legacy" },
      }),
      defaults,
    );

    expect(settings.ocr.pipeline).toBe("paddle-legacy");
    expect(
      buildMacTranslationOptions(settings, "mac-economy-english-ocr"),
    ).toMatchObject({
      sourceLanguage: "en",
      ocrPipeline: "paddle-legacy",
      ocrBboxProvider: "paddleocr",
      ocrTextRecognitionModelName: "PP-OCRv6_small_rec",
    });
  });

  it("preserves a saved Paddle GPU route instead of silently selecting Hayai or CPU", () => {
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
          pipeline: "paddle-legacy",
          device: "gpu",
          gpuBackend: "cuda",
          qualityMode: "cuda-legacy-full",
        },
      }),
      defaults,
    );

    expect(settings.ocr).toMatchObject({
      pipeline: "paddle-legacy",
      device: "gpu",
      gpuBackend: "cuda",
      qualityMode: "full",
    });

    const options = buildMacTranslationOptions(settings, "mac-legacy-ocr");

    expect(options).toMatchObject({
      ocrPipeline: "paddle-legacy",
      ocrBboxProvider: "paddleocr",
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
