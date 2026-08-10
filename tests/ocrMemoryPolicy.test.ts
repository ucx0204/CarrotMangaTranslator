import { describe, expect, it } from "vitest";
import {
  OCR_FULL_RECOMMENDED_GPU_MEMORY_MB,
  resolveRecommendedOcrQualityMode,
} from "../src/shared/ocrMemoryPolicy";

describe("OCR memory recommendation policy", () => {
  it("uses full quality at and above the measured-memory floor", () => {
    expect(
      resolveRecommendedOcrQualityMode({
        ocrDevice: "gpu",
        gpuMemoryMb: OCR_FULL_RECOMMENDED_GPU_MEMORY_MB,
      }),
    ).toBe("full");
    expect(
      resolveRecommendedOcrQualityMode({
        ocrDevice: "gpu",
        gpuMemoryMb: 8 * 1024,
      }),
    ).toBe("full");
  });

  it("falls back to economy below the floor or when memory is unknown", () => {
    expect(
      resolveRecommendedOcrQualityMode({
        ocrDevice: "gpu",
        gpuMemoryMb: OCR_FULL_RECOMMENDED_GPU_MEMORY_MB - 1,
      }),
    ).toBe("economy");
    expect(
      resolveRecommendedOcrQualityMode({
        ocrDevice: "gpu",
        gpuMemoryMb: null,
      }),
    ).toBe("economy");
    expect(
      resolveRecommendedOcrQualityMode({
        ocrDevice: "cpu",
        gpuMemoryMb: 24 * 1024,
      }),
    ).toBe("economy");
  });
});
