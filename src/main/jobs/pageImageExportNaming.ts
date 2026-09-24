import { basename, extname } from "node:path";
import { resolveSourceImageFormat } from "../../shared/sourceImageFormat";

export function formatPageImageExportOrder(index: number): string {
  return String(index + 1).padStart(3, "0");
}

export function sanitizeOutputBaseName(value: string): string {
  const raw = basename(value, extname(value)) || "page";
  return sanitizeOutputPathSegment(raw, "page");
}

export function sanitizeOutputPathSegment(
  value: string,
  fallback: string,
): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 80);
  const resolved =
    cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(resolved)
    ? `_${resolved}`
    : resolved;
}

export function buildPageImageExportRelativePath({
  chapterIndex,
  chapterTitle,
  pageIndex,
  pageName,
  sourceFileName,
  outputFormat = "source",
}: {
  chapterIndex: number;
  chapterTitle: string;
  pageIndex: number;
  pageName: string;
  sourceFileName?: string;
  outputFormat?: "source" | "png" | "jpeg" | "webp" | "psd";
}): string {
  const extension =
    outputFormat === "source"
      ? resolveSourceImageFormat(extname(sourceFileName ?? pageName)).extension
      : outputFormat === "jpeg"
        ? "jpg"
        : outputFormat;
  return `${formatPageImageExportOrder(chapterIndex)}-${sanitizeOutputPathSegment(
    chapterTitle,
    "chapter",
  )}\\${formatPageImageExportOrder(pageIndex)}-${sanitizeOutputBaseName(
    pageName,
  )}.${extension}`;
}
