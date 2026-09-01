import type { TFunction } from "i18next";
import { translate } from "./appHelpers";

export function formatBytes(
  bytes: number | null | undefined,
  locale?: string,
): string | null {
  if (!Number.isFinite(bytes) || (bytes ?? 0) < 0) {
    return null;
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes ?? 0;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  const formatted = locale
    ? new Intl.NumberFormat(locale, {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      }).format(value)
    : value.toFixed(digits);
  return `${formatted} ${units[unitIndex]}`;
}

export function summarizeWarnings(
  warnings: string[],
  t?: TFunction<"renderer">,
): string | null {
  if (warnings.length === 0) {
    return null;
  }

  const skipped = warnings.filter(isSkippedPageWarning).length;
  const uncertain = warnings.filter(isUncertainOcrWarning).length;
  if (skipped > 0 && uncertain > 0) {
    return translate(
      t,
      "job.warnings.skippedAndUncertain",
      "일부 페이지를 건너뛰었고 OCR 확인이 필요한 블록도 있습니다.",
    );
  }
  if (skipped > 0) {
    return translate(
      t,
      "job.warnings.skipped",
      "일부 페이지는 건너뛰고 다음 페이지로 진행했습니다.",
    );
  }
  if (uncertain > 0) {
    return translate(
      t,
      "job.warnings.uncertain",
      "일부 블록은 OCR 확인이 더 필요합니다.",
    );
  }
  return translate(
    t,
    "job.warnings.generic",
    "중간 경고가 있었지만 작업은 계속 진행되었습니다.",
  );
}

function isSkippedPageWarning(warning: string): boolean {
  return warning.startsWith("page_skipped:") || warning.includes("건너뜁니다");
}

function isUncertainOcrWarning(warning: string): boolean {
  return (
    warning.startsWith("uncertain_ocr:") || warning.includes("불확실한 OCR")
  );
}
