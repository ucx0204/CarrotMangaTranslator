import { z } from "zod/v4";
import { MCP_EXCHANGE_MIME_TYPES } from "./mcpExchangeFiles";

export const McpRasterExportOptionsSchema = z
  .object({
    format: z.enum(["png", "jpeg", "webp"]),
    omitText: z.boolean().default(false),
    quality: z.number().int().min(1).max(100).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.format === "png"
        ? value.quality === undefined
        : value.quality !== undefined,
    "JPEG/WebP require quality; PNG must omit quality.",
  );
export type McpRasterExportOptions = z.infer<
  typeof McpRasterExportOptionsSchema
>;
export const McpPsdExportOptionsSchema = z
  .object({
    format: z.literal("psd"),
    omitText: z.literal(false).default(false),
    quality: z.never().optional(),
    acknowledgeOriginalLayer: z.literal(true),
    acknowledgeRasterLayers: z.literal(true),
  })
  .strict();
export const McpPageExportOptionsSchema = z.union([
  McpRasterExportOptionsSchema,
  McpPsdExportOptionsSchema,
]);
export type McpPageExportOptions = z.infer<typeof McpPageExportOptionsSchema>;

export const MCP_ARTIFACT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/vnd.adobe.photoshop",
  "application/zip",
  "application/vnd.carrot.mgtshare",
  ...MCP_EXCHANGE_MIME_TYPES,
] as const;
export const McpArtifactMimeSchema = z.enum(MCP_ARTIFACT_MIME_TYPES);
export type McpArtifactMime = z.infer<typeof McpArtifactMimeSchema>;

export function mcpArtifactRequiresImages(mimeType: McpArtifactMime): boolean {
  return !MCP_EXCHANGE_MIME_TYPES.some((mime) => mime === mimeType);
}

const rasterFormats = {
  png: { mimeType: "image/png", name: "page.png", extension: "png" },
  jpeg: { mimeType: "image/jpeg", name: "page.jpg", extension: "jpg" },
  webp: { mimeType: "image/webp", name: "page.webp", extension: "webp" },
} as const;
export function mcpRasterFormat(format: McpRasterExportOptions["format"]) {
  const result = rasterFormats[format];
  if (!result) throw new Error("Unsupported MCP raster output format.");
  return result;
}
export function mcpPageOutputFormat(format: McpPageExportOptions["format"]) {
  return format === "psd"
    ? {
        mimeType: "image/vnd.adobe.photoshop" as const,
        name: "page.psd" as const,
        extension: "psd" as const,
      }
    : mcpRasterFormat(format);
}
export function mcpArtifactName(mimeType: McpArtifactMime) {
  switch (mimeType) {
    case "image/png":
      return "page.png" as const;
    case "image/jpeg":
      return "page.jpg" as const;
    case "image/webp":
      return "page.webp" as const;
    case "image/vnd.adobe.photoshop":
      return "page.psd" as const;
    case "application/zip":
      return "pages.zip" as const;
    case "application/vnd.carrot.mgtshare":
      return "work.mgtshare" as const;
    case "text/plain":
      return "text.txt" as const;
    case "text/csv":
      return "review.csv" as const;
    case "text/tab-separated-values":
      return "review.tsv" as const;
    case "application/json":
      return "context.json" as const;
  }
}
export function mcpArtifactMime(name: string): McpArtifactMime {
  switch (name) {
    case "page.png":
      return "image/png";
    case "page.jpg":
      return "image/jpeg";
    case "page.webp":
      return "image/webp";
    case "page.psd":
      return "image/vnd.adobe.photoshop";
    case "pages.zip":
      return "application/zip";
    case "work.mgtshare":
      return "application/vnd.carrot.mgtshare";
    case "text.txt":
      return "text/plain";
    case "review.csv":
      return "text/csv";
    case "review.tsv":
      return "text/tab-separated-values";
    case "context.json":
      return "application/json";
    default:
      throw new Error("Unsupported MCP artifact filename.");
  }
}
