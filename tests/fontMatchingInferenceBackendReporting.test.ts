import { afterEach, describe, expect, it, vi } from "vitest";
import { reportFontMatchingInferenceBackend } from "../src/main/pipeline/fontMatchingInferenceBackendReporting";

const previousBackend = process.env.MANGA_TRANSLATOR_FONT_MATCHING_BACKEND;

describe("font matching inference backend reporting", () => {
  afterEach(() => {
    if (previousBackend === undefined) {
      delete process.env.MANGA_TRANSLATOR_FONT_MATCHING_BACKEND;
    } else {
      process.env.MANGA_TRANSLATOR_FONT_MATCHING_BACKEND = previousBackend;
    }
  });

  it("reports the requested backend as ready", () => {
    process.env.MANGA_TRANSLATOR_FONT_MATCHING_BACKEND = "wasm";
    const reportInfo = vi.fn();
    const reportWarning = vi.fn();

    reportFontMatchingInferenceBackend({
      activeBackend: "wasm",
      reportInfo,
      reportWarning,
    });

    expect(reportInfo).toHaveBeenCalledWith(
      "Font matching inference backend ready",
      { requestedBackend: "wasm", activeBackend: "wasm" },
    );
    expect(reportWarning).not.toHaveBeenCalled();
  });

  it("reports a GPU-to-WASM fallback", () => {
    process.env.MANGA_TRANSLATOR_FONT_MATCHING_BACKEND = "webgpu";
    const reportInfo = vi.fn();
    const reportWarning = vi.fn();

    reportFontMatchingInferenceBackend({
      activeBackend: "wasm",
      reportInfo,
      reportWarning,
    });

    expect(reportInfo).not.toHaveBeenCalled();
    expect(reportWarning).toHaveBeenCalledWith(
      "Font matching GPU backend was unavailable; using WASM fallback.",
      { requestedBackend: "webgpu", activeBackend: "wasm" },
    );
  });
});
