import { createHash } from "node:crypto";
import type { ImportChapterDraft } from "../../shared/importTypes";
import { ImportSourceIdentitySchema } from "../../shared/importSourceIdentity";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpImportSourcePageIdentity } from "../application/mcpImportMappingPolicy";
import { canonicalizeWebImageUrl } from "../webImportUrlPolicy";
import {
  MAX_IMPORT_IMAGE_BYTES,
  openZipArchiveReader,
  type ZipArchiveReader,
} from "../libraryStore/zipSafety";

export type McpCapturedSource = { path: string; bytes: number; sha256: string };
const MAX_SELECTED_BYTES = 256 * 1024 * 1024;

/** Called only with reserved, verified native previews. No caller paths are accepted. */
export async function identifyMcpImportSources(
  chapters: ImportChapterDraft[],
  captured: McpCapturedSource[],
  guard: () => void,
  sourceUrl?: string,
  observePage?: (identity: McpImportSourcePageIdentity) => void,
): Promise<ImportChapterDraft[]> {
  const sources = new Map(captured.map((source) => [source.path, source]));
  const readers = new Map<string, ZipArchiveReader>();
  const result: ImportChapterDraft[] = [];
  const urlSha256 =
    sourceUrl === undefined ? undefined : hashSourceUrl(sourceUrl);
  let bytes = 0;
  try {
    for (const chapter of chapters) {
      const hashes: string[] = [];
      for (const [pageIndex, page] of chapter.pages.entries()) {
        guard();
        const source = sources.get(page.sourcePath);
        assertCapturedSource(source);
        const fingerprint = await identifyPage(
          page,
          source,
          readers,
          MAX_SELECTED_BYTES - bytes,
        );
        bytes += fingerprint.bytes;
        hashes.push(fingerprint.sha256);
        guard();
        observePage?.({
          draftId: chapter.draftId,
          pageIndex,
          bytes: fingerprint.bytes,
          sha256: fingerprint.sha256,
        });
      }
      result.push({
        ...chapter,
        importSource: ImportSourceIdentitySchema.parse({
          version: 1,
          basis: "selected-input-bytes",
          selectionSha256: digest(JSON.stringify(hashes)),
          pageCount: hashes.length,
          ...(urlSha256 ? { urlSha256 } : {}),
        }),
      });
    }
    return result;
  } finally {
    for (const reader of readers.values()) reader.close();
  }
}

async function identifyPage(
  page: ImportChapterDraft["pages"][number],
  source: McpCapturedSource,
  readers: Map<string, ZipArchiveReader>,
  remaining: number,
) {
  if (
    remaining <= 0 ||
    (page.sourceKind === "file" && source.bytes > remaining)
  )
    throw new McpEditError(
      "invalid_edit",
      "Selected input exceeds the 256-MiB identity budget.",
    );
  if (page.sourceKind === "file") return source;
  let reader = readers.get(source.path);
  if (!reader) {
    reader = await openZipArchiveReader(source.path, "Reviewed import archive");
    readers.set(source.path, reader);
  }
  if (!page.zipEntryName)
    throw new McpEditError(
      "invalid_edit",
      "Selected archive page has no native entry name.",
    );
  const buffer = await reader.readEntry(
    page.zipEntryName,
    Math.min(remaining, MAX_IMPORT_IMAGE_BYTES),
    "Reviewed import page",
  );
  return { bytes: buffer.length, sha256: digest(buffer) };
}
function hashSourceUrl(value: string) {
  const canonical = canonicalizeWebImageUrl(value);
  if (!canonical)
    throw new McpEditError(
      "invalid_edit",
      "Source identity requires a canonical public HTTP(S) URL without credentials.",
    );
  return digest(canonical);
}
function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function assertCapturedSource(
  source: McpCapturedSource | undefined,
): asserts source is McpCapturedSource {
  if (!source)
    throw new McpEditError(
      "invalid_edit",
      "Selected source is outside the captured input.",
    );
}
