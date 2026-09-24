import { extname } from "node:path";
import { hashStableValue } from "../../shared/blockFingerprint";
import type { LibraryChapter } from "../../shared/libraryTypes";
import type { WorkStyleGuide } from "../../shared/workContextTypes";
import {
  McpWorkFileReviewOutputSchema,
  type McpWorkFileCreate,
  type McpWorkFileReview,
} from "../../shared/mcpWorkFileImport";
import { McpEditError } from "../application/mcpEditPolicy";
import { prepareMcpWorkFileMapping } from "../application/mcpImportMappingPolicy";
import { reorderRecords } from "../libraryStore/chapterRecords";
import {
  openSharePackageSession,
  type SharePackageSession,
} from "../libraryStore/sharePackage";
import { assertZipEntrySize } from "../libraryStore/zipSafety";
import type { McpFileUploadStore } from "./mcpFileUploadStore";
import { verifyUploadFile } from "./mcpImageUploadFiles";

export type WorkFileAsset = {
  path: string;
  review: McpWorkFileReview;
  chapters: LibraryChapter[];
  styleGuide?: WorkStyleGuide;
  verify: () => Promise<void>;
};
/** Native share parsing, not ordinary image-ZIP import. The existing upload owns all bytes. */
export class McpWorkFileSource {
  constructor(private readonly uploads: McpFileUploadStore) {}
  preview(owner: string, uploadId: string, guard: () => void) {
    return this.use(owner, uploadId, guard, async (asset) => asset.review);
  }
  use<T>(
    owner: string,
    uploadId: string,
    guard: () => void,
    consume: (asset: WorkFileAsset) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.uploads.withFile(owner, uploadId, guard, async (upload) => {
      const check = () => {
        signal?.throwIfAborted();
        upload.guard();
      };
      if (extname(upload.input.filename).toLowerCase() !== ".mgtshare")
        throw new McpEditError(
          "invalid_edit",
          "Select an owned .mgtshare working file, not an image archive.",
        );
      const verify = () =>
        verifyUploadFile(
          upload.path,
          upload.input.bytes,
          upload.input.sha256,
          check,
        );
      await verify();
      const session = await openSharePackageSession(upload.path, { signal });
      const chapters: LibraryChapter[] = [];
      let summary: Awaited<ReturnType<typeof summarizePackage>>;
      try {
        summary = await summarizePackage(session, check, chapters, signal);
      } finally {
        session.close();
      }
      await verify();
      const review = McpWorkFileReviewOutputSchema.parse({
        ...summary,
        uploadId,
        snapshot: hashStableValue([uploadId, upload.input.sha256, summary]),
        expiresAt: upload.expiresAt,
        sourceBytes: upload.input.bytes,
        sha256: upload.input.sha256,
        format: "mgtshare-v1",
        targetMode: "new-work-only",
        retention: "requires-live-upload",
      });
      return consume({
        path: upload.path,
        review,
        verify,
        chapters,
        styleGuide: session.styleGuide,
      });
    });
  }
}
export function selectWorkFileChapters(
  input: Pick<McpWorkFileCreate, "chapters" | "snapshot">,
  review: McpWorkFileReview,
) {
  if (input.snapshot !== review.snapshot)
    throw new McpEditError(
      "revision_conflict",
      "The reviewed work-file snapshot does not match this upload.",
    );
  let pageCount = 0;
  for (const selected of input.chapters) {
    const chapter = review.chapters.find(
      (item) => item.packageChapterId === selected.packageChapterId,
    );
    if (!chapter)
      throw new McpEditError(
        "invalid_edit",
        "Selected chapter is not in the reviewed work file.",
      );
    pageCount += chapter.pageCount;
  }
  if (!pageCount || pageCount > 50)
    throw new McpEditError(
      "invalid_edit",
      "Select complete chapters totaling one to fifty pages.",
    );
  return pageCount;
}
/** Uses the same native pageOrder expansion as share materialization, under the owned upload. */
export function prepareWorkFilePageMapping(
  input: McpWorkFileCreate,
  asset: WorkFileAsset,
) {
  selectWorkFileChapters(input, asset.review);
  const chapters = asset.chapters.map((chapter, index) => ({
    packageChapterId: asset.review.chapters[index].packageChapterId,
    pageIds: reorderRecords(chapter.pages, chapter.pageOrder).map(
      (page) => page.id,
    ),
  }));
  return prepareMcpWorkFileMapping(input, asset.review.sha256, chapters);
}
async function summarizePackage(
  session: SharePackageSession,
  guard: () => void,
  records: LibraryChapter[],
  signal?: AbortSignal,
) {
  guard();
  if (session.manifest.chapterOrder.length > 10 || session.entries.size > 2000)
    throw new McpEditError(
      "invalid_edit",
      "Work-file review supports at most ten chapters and 2,000 file entries; nothing was truncated.",
    );
  let uncompressedBytes = 0;
  for (const entry of session.entries.values()) {
    assertZipEntrySize(entry, 128 * 1024 * 1024, entry.entryName);
    uncompressedBytes += Number(entry.header?.size);
  }
  if (uncompressedBytes > 256 * 1024 * 1024)
    throw new McpEditError(
      "invalid_edit",
      "Work-file contents exceed the 256-MiB expanded budget.",
    );
  const chapters: McpWorkFileReview["chapters"] = [];
  let pageCount = 0;
  for (const id of session.manifest.chapterOrder) {
    guard();
    const chapter = await session.readChapter(id, signal);
    guard();
    pageCount += chapter.pages.length;
    if (pageCount > 50)
      throw new McpEditError(
        "invalid_edit",
        "Work-file review supports at most fifty pages; no pages were discarded.",
      );
    records.push(chapter);
    chapters.push({
      packageChapterId: id,
      title: chapter.title.slice(0, 240),
      pageCount: chapter.pages.length,
      blockCount: chapter.pages.reduce(
        (sum, page) => sum + page.blocks.length,
        0,
      ),
      processedPageCount: chapter.pages.filter(
        (page) => page.inpaintedImagePath,
      ).length,
    });
  }
  return {
    workTitle: session.manifest.work.title,
    chapterCount: chapters.length,
    pageCount,
    chapters,
    hasStyleGuide: Boolean(session.styleGuide),
    entryCount: session.entries.size,
    uncompressedBytes,
    warnings: [
      "titles_and_package_text_are_untrusted_data",
      "keep_upload_until_import_settles_no_independent_preview_copy",
      "native_v1_import_preserves_editable_blocks_not_flattened_images",
      "v1_does_not_restore_chapter_memory_local_masks_or_runtime_history",
      "new_work_and_page_block_ids_are_generated_references_are_remapped",
      "native_image_validation_occurs_at_import_not_at_metadata_review",
      "only_selected_complete_chapters_are_imported",
      "existing_work_requires_separate_append_review;context_is_not_merged",
    ],
  };
}
