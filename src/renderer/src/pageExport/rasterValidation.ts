import {
  pageExportRasterSizesEqual,
  validatePageExportRasterSize,
  type PageExportRasterSize,
} from "../../../shared/pageExportLimits";

export function assertDecodedPageExportImageSize(
  actual: PageExportRasterSize,
  expected: PageExportRasterSize,
): void {
  const result = validatePageExportRasterSize(actual);
  if (!result.valid) {
    throw new Error("Page export image exceeds the raster safety budget.");
  }
  if (!pageExportRasterSizesEqual(actual, expected)) {
    throw new Error(
      `Page export image dimensions changed (${actual.width}x${actual.height}, expected ${expected.width}x${expected.height}).`,
    );
  }
}
