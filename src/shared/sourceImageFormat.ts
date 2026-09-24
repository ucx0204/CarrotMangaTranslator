/** Resolve the native source-extension policy; callers own pathname parsing. */
export function resolveSourceImageFormat(extension: string): {
  format: "png" | "jpeg" | "webp";
  extension: "png" | "jpg" | "jpeg" | "webp";
  fallback: "none" | "unsupported-source-to-png";
} {
  const normalized = extension.toLowerCase();
  if (normalized === ".jpg" || normalized === ".jpeg")
    return {
      format: "jpeg",
      extension: normalized === ".jpg" ? "jpg" : "jpeg",
      fallback: "none",
    };
  if (normalized === ".webp")
    return { format: "webp", extension: "webp", fallback: "none" };
  return {
    format: "png",
    extension: "png",
    fallback: normalized === ".png" ? "none" : "unsupported-source-to-png",
  };
}
