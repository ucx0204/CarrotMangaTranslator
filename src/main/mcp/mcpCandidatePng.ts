import { nativeImage } from "electron";
import { McpEditError } from "../application/mcpEditPolicy";

export function reduceMcpCandidatePng(bytes: Buffer) {
  const image = nativeImage.createFromBuffer(bytes),
    size = image.getSize();
  if (image.isEmpty())
    throw new McpEditError(
      "invalid_edit",
      "Candidate image cannot be decoded.",
    );
  const scale = Math.min(1, 1600 / Math.max(size.width, size.height));
  const previewWidth = Math.max(1, Math.round(size.width * scale));
  const previewHeight = Math.max(1, Math.round(size.height * scale));
  const data = image
    .resize({ width: previewWidth, height: previewHeight, quality: "best" })
    .toPNG();
  if (data.length > 4 * 1024 * 1024)
    throw new McpEditError("invalid_edit", "Candidate preview exceeds 4 MiB.");
  return {
    width: size.width,
    height: size.height,
    previewWidth,
    previewHeight,
    imageData: data.toString("base64"),
  };
}
