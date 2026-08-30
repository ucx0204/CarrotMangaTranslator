export const ZIP_ARCHIVE_EXTENSIONS = [".zip", ".cbz"] as const;
export const RAR_ARCHIVE_EXTENSIONS = [".rar", ".cbr"] as const;
export const SUPPORTED_ARCHIVE_EXTENSIONS = [
  ...ZIP_ARCHIVE_EXTENSIONS,
  ...RAR_ARCHIVE_EXTENSIONS,
] as const;
export const PDF_EXTENSION = ".pdf" as const;
