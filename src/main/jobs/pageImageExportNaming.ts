import { basename, extname } from "node:path";

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
  outputFormat = "source",
}: {
  chapterIndex: number;
  chapterTitle: string;
  pageIndex: number;
  pageName: string;
  outputFormat?: "source" | "png" | "jpeg" | "webp" | "psd";
}): string {
  const extension =
    outputFormat === "source"
      ? resolveSourceOutputExtension(pageName)
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

function resolveSourceOutputExtension(pageName: string): string {
  const extension = extname(pageName).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return extension.slice(1);
  if (extension === ".webp") return "webp";
  return "png";
}
