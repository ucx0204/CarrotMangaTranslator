import { createHash } from "node:crypto";
import { extname } from "node:path";
import type { MangaPage } from "../../shared/libraryTypes";
import type { McpExportSourceName } from "../../shared/mcpExportBatch";
import { resolveSourceImageFormat } from "../../shared/sourceImageFormat";

/** Same saved-name authority as native manual export; raw names stay behind this adapter. */
export function readMcpExportSourceName(
  page: Pick<MangaPage, "name" | "sourceFileName">,
): McpExportSourceName {
  const sourceName = page.sourceFileName ?? page.name;
  const { format, fallback } = resolveSourceImageFormat(extname(sourceName));
  return {
    format,
    fallback,
    sourceNameFingerprint: createHash("sha256")
      .update(JSON.stringify({ version: 1, sourceName }))
      .digest("hex"),
  };
}
