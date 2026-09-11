import {
  PAGE_EXPORT_SOURCE_RASTER_LIMITS,
  validatePageExportRasterSize,
  type PageExportRasterSize,
} from "./pageExportLimits";

export const IMAGE_REDACTION_SIZE_ERROR =
  "가리기 이미지 크기가 지원 범위를 벗어났습니다.";

/** Use the source raster budget at every entry, before reading or allocating. */
export function isSupportedRedactionSize(size: PageExportRasterSize): boolean {
  return validatePageExportRasterSize(size, PAGE_EXPORT_SOURCE_RASTER_LIMITS)
    .valid;
}

export function assertSupportedRedactionSize(size: PageExportRasterSize): void {
  if (!isSupportedRedactionSize(size))
    throw new Error(IMAGE_REDACTION_SIZE_ERROR);
}
