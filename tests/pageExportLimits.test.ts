import { describe, expect, it } from "vitest";
import {
  MAX_PAGE_EXPORT_IMAGE_SOURCE_CHARS,
  MAX_PAGE_EXPORT_ORIGINAL_IMAGE_BYTES,
  MAX_PAGE_EXPORT_ORIGINAL_PIXELS,
  MAX_PAGE_EXPORT_ORIGINAL_SIDE_PX,
  MAX_PAGE_EXPORT_PIXELS,
  MAX_PAGE_EXPORT_PNG_BYTES,
  MAX_PAGE_EXPORT_SCREENSHOT_BASE64_CHARS,
  MAX_PAGE_EXPORT_SIDE_PX,
  ORIGINAL_PAGE_EXPORT_RASTER_LIMITS,
  estimateBase64DecodedByteLength,
  fitPageExportRasterSize,
  validatePageExportRasterSize,
} from "../src/shared/pageExportLimits";

describe("page export raster limits", () => {
  it("defines the central raster and encoded budgets", () => {
    expect(MAX_PAGE_EXPORT_SIDE_PX).toBe(16_384);
    expect(MAX_PAGE_EXPORT_PIXELS).toBe(16_777_216);
    expect(MAX_PAGE_EXPORT_ORIGINAL_SIDE_PX).toBe(100_000);
    expect(MAX_PAGE_EXPORT_ORIGINAL_PIXELS).toBe(120_000_000);
    expect(MAX_PAGE_EXPORT_ORIGINAL_IMAGE_BYTES).toBe(512 * 1024 * 1024);
    expect(MAX_PAGE_EXPORT_PNG_BYTES).toBe(96 * 1024 * 1024);
    expect(MAX_PAGE_EXPORT_SCREENSHOT_BASE64_CHARS).toBe(
      Math.ceil(MAX_PAGE_EXPORT_PNG_BYTES / 3) * 4,
    );
    expect(MAX_PAGE_EXPORT_IMAGE_SOURCE_CHARS).toBe(
      MAX_PAGE_EXPORT_SCREENSHOT_BASE64_CHARS + 64,
    );
  });

  it("accepts the exact 4096x4096 pixel boundary", () => {
    expect(validatePageExportRasterSize({ width: 4096, height: 4096 })).toEqual(
      { valid: true, pixelCount: 16_777_216 },
    );
  });

  it("rejects one row over the pixel boundary", () => {
    expect(validatePageExportRasterSize({ width: 4096, height: 4097 })).toEqual(
      { valid: false, reason: "pixel-limit" },
    );
  });

  it("rejects a side above 16384", () => {
    expect(validatePageExportRasterSize({ width: 16_385, height: 1 })).toEqual({
      valid: false,
      reason: "side-limit",
    });
  });

  it("accepts a long image that remains within the total pixel budget", () => {
    expect(
      validatePageExportRasterSize({ width: 1024, height: 16_384 }),
    ).toEqual({ valid: true, pixelCount: 16_777_216 });
  });

  it("allows the explicit original-resolution budget up to 120 megapixels", () => {
    expect(
      validatePageExportRasterSize(
        { width: 10_000, height: 12_000 },
        ORIGINAL_PAGE_EXPORT_RASTER_LIMITS,
      ),
    ).toEqual({ valid: true, pixelCount: 120_000_000 });
    expect(
      validatePageExportRasterSize(
        { width: 5_000, height: 24_000 },
        ORIGINAL_PAGE_EXPORT_RASTER_LIMITS,
      ),
    ).toEqual({ valid: true, pixelCount: 120_000_000 });
  });

  it("fits the reported 4445x6053 page into the safe budget", () => {
    const fitted = fitPageExportRasterSize({ width: 4445, height: 6053 });

    expect(fitted).toEqual({ width: 3510, height: 4779 });
    expect(validatePageExportRasterSize(fitted).valid).toBe(true);
    expect(fitted.width / fitted.height).toBeCloseTo(4445 / 6053, 3);
  });

  it.each([
    { width: 0, height: 1 },
    { width: -1, height: 1 },
    { width: Number.NaN, height: 1 },
    { width: Number.POSITIVE_INFINITY, height: 1 },
    { width: 1.5, height: 1 },
    { width: Number.MAX_SAFE_INTEGER + 1, height: 1 },
  ])("rejects invalid dimensions %#", (size) => {
    expect(validatePageExportRasterSize(size)).toEqual({
      valid: false,
      reason: "invalid-dimensions",
    });
  });

  it("estimates padded and unpadded base64 decoded lengths", () => {
    expect(estimateBase64DecodedByteLength("")).toBe(0);
    expect(estimateBase64DecodedByteLength("YQ==")).toBe(1);
    expect(estimateBase64DecodedByteLength("YWI=")).toBe(2);
    expect(estimateBase64DecodedByteLength("YWJj")).toBe(3);
    expect(() => estimateBase64DecodedByteLength("abc")).toThrow(
      "Invalid base64 length",
    );
  });
});
