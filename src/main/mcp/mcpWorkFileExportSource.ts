import { hashStableValue } from "../../shared/blockFingerprint";
import { createPageRevision } from "../../shared/pageRevision";
import {
  MCP_WORK_FILE_EXPANDED_BYTES,
  MCP_WORK_FILE_OUTPUT_BYTES,
  MCP_WORK_FILE_ENTRY_COUNT,
  McpWorkFileExportReviewInputSchema,
  McpWorkFileExportReviewSchema,
  type McpWorkFileExportBinding,
  type McpWorkFileExportReviewInput,
} from "../../shared/mcpWorkFileExport";
import type { McpWorkFileExportState } from "../application/mcpWorkFileExportService";
import { McpEditError } from "../application/mcpEditPolicy";
import { withLibraryRead } from "../library/lock";
import { createWorkShareExport } from "../library/libraryShareFacade";
import {
  captureWorkShareSnapshot,
  exportWorkShareToFile,
} from "../libraryStore/shareExportWorkflow";
import { reorderRecords } from "../libraryStore/chapterRecords";
import {
  captureRetainedPage,
  watchRetainedFiles,
} from "./mcpRetentionEvidence";

type Captured = Awaited<ReturnType<typeof captureWorkShareSnapshot>>;
type Chapter = NonNullable<
  Awaited<ReturnType<Captured["readers"]["loadChapter"]>>
>;

export function readMcpWorkFileExportState(
  input: McpWorkFileExportReviewInput,
  guard: () => void,
  signal?: AbortSignal,
): Promise<McpWorkFileExportState> {
  return withLibraryRead(async () => {
    const parsed = McpWorkFileExportReviewInputSchema.safeParse(input);
    if (!parsed.success)
      throw invalid("Use one work and one to ten distinct chapter IDs.");
    const request = parsed.data;
    guard();
    const captured = await captureWorkShareSnapshot(request, signal);
    const state = await describeCaptured(request, captured);
    const sources = await captureSources(state.chapters, guard, signal);
    return {
      review: exportReview(state, sources),
      bindings: sources.bindings,
      verifySources: sources.verifySources,
    };
  });
}

async function captureSources(
  chapters: Chapter[],
  guard: () => void,
  signal?: AbortSignal,
) {
  const bindings: McpWorkFileExportState["bindings"] = [];
  const files: Awaited<ReturnType<typeof captureRetainedPage>>["files"] = [];
  let sourceImageBytes = 0;
  for (const chapter of chapters) {
    for (const page of reorderRecords(chapter.pages, chapter.pageOrder)) {
      signal?.throwIfAborted();
      guard();
      const evidence = await capturePageSource(chapter.id, page);
      files.push(...evidence.files);
      sourceImageBytes += evidence.sourceImageBytes;
      if (sourceImageBytes > MCP_WORK_FILE_EXPANDED_BYTES)
        throw invalid(
          "Working-file images exceed the 256-MiB expanded budget.",
        );
      bindings.push(evidence.binding);
    }
  }
  const verifySources = await watchRetainedFiles([
    ...new Map(files.map((file) => [file.path, file])).values(),
  ]);
  signal?.throwIfAborted();
  guard();
  return { bindings, verifySources, sourceImageBytes };
}

async function capturePageSource(
  chapterId: string,
  page: Chapter["pages"][number],
) {
  const evidence = await captureRetainedPage(page);
  let sourceImageBytes = 0;
  for (const path of [page.imagePath, page.inpaintedImagePath]) {
    if (!path) continue;
    const file = evidence.files.find((item) => item.path === path);
    if (!file) throw invalid("Working-file image evidence is incomplete.");
    sourceImageBytes += file.bytes;
  }
  return {
    files: evidence.files,
    sourceImageBytes,
    binding: {
      chapterId,
      pageId: page.id,
      revision: createPageRevision(page),
      sourceFingerprint: hashStableValue(evidence.files),
    },
  };
}

function exportReview(
  state: Awaited<ReturnType<typeof describeCaptured>>,
  sources: Awaited<ReturnType<typeof captureSources>>,
) {
  return McpWorkFileExportReviewSchema.parse({
    ...state.metadata,
    sourceSnapshot: hashStableValue(sources.bindings),
    sourceImageBytes: sources.sourceImageBytes,
    includesStyleGuide: true,
    entryCount: state.entryCount,
    outputLimitBytes: MCP_WORK_FILE_OUTPUT_BYTES,
    expandedLimitBytes: MCP_WORK_FILE_EXPANDED_BYTES,
    sizingChecked: "during-native-write",
    executionReserved: false,
    warnings: [
      "native_v1_preserves_editable_blocks_supported_formatting_and_reading_order",
      "original_images_and_saved_processed_images_are_included",
      "work_style_guide_is_included_and_may_contain_whole_work_information",
      "v1_omits_local_masks_chapter_memory_jobs_undo_history_and_profile_settings",
      "v1_omits_internal_translation_checkpoints_and_font_continuity",
      "fonts_are_not_bundled",
      "only_saved_data_and_selected_complete_chapters_are_exported",
      "native_stream_enforces_actual_bytes_no_format_substitution_or_truncation",
      "generation_and_file_retrieval_do_not_confirm_client_receipt",
    ],
  });
}

/** Retention invokes this inside its existing lock; never recursively acquire one. */
export async function checkMcpWorkFileExportBindingUnlocked(
  binding: McpWorkFileExportBinding,
): Promise<void> {
  const captured = await captureWorkShareSnapshot(binding);
  const state = await describeCaptured(binding, captured);
  assertBinding(binding, state.metadata);
}

export function checkMcpWorkFileExportBinding(
  binding: McpWorkFileExportBinding,
) {
  return withLibraryRead(() => checkMcpWorkFileExportBindingUnlocked(binding));
}

/** Native facade retains the very readers checked here through atomic ZIP completion. */
export async function writeMcpWorkFileExport(
  binding: McpWorkFileExportBinding,
  outputPath: string,
  guard: () => void,
  signal: AbortSignal,
): Promise<void> {
  const exportFile = createWorkShareExport({
    runRead: withLibraryRead,
    exportWorkShare: exportWorkShareToFile,
    capture: async (request, activeSignal) => {
      guard();
      const captured = await captureWorkShareSnapshot(request, activeSignal);
      const state = await describeCaptured(binding, captured);
      assertBinding(binding, state.metadata);
      guard();
      return captured;
    },
  });
  signal.throwIfAborted();
  guard();
  await exportFile(
    {
      workId: binding.workId,
      chapterIds: binding.chapterIds,
      outputPath,
      limits: {
        maxOutputBytes: MCP_WORK_FILE_OUTPUT_BYTES,
        maxUncompressedBytes: MCP_WORK_FILE_EXPANDED_BYTES,
        maxEntries: MCP_WORK_FILE_ENTRY_COUNT,
      },
    },
    signal,
  );
  signal.throwIfAborted();
  guard();
}

async function describeCaptured(
  input: McpWorkFileExportReviewInput,
  captured: Captured,
) {
  const work = await captured.readers.loadWork(input.workId);
  const chapterIds = selectedChapterIds(input, work);
  const chapters: Chapter[] = [];
  let pageCount = 0;
  let blockCount = 0;
  let entryCount = 2 + chapterIds.length;
  for (const id of chapterIds) {
    const chapter = await captured.readers.loadChapter(work.id, id);
    if (!chapter || chapter.id !== id || chapter.workId !== work.id)
      throw invalid("A selected chapter is unavailable in this work.");
    pageCount += chapter.pages.length;
    blockCount += chapter.pages.reduce(
      (sum, page) => sum + page.blocks.length,
      0,
    );
    entryCount +=
      chapter.pages.length +
      chapter.pages.filter((page) => page.inpaintedImagePath).length;
    if (pageCount > 50 || entryCount > MCP_WORK_FILE_ENTRY_COUNT)
      throw invalid(
        "Select complete chapters totaling at most fifty pages and 2,000 archive entries.",
      );
    chapters.push(chapter);
  }
  if (!pageCount)
    throw invalid("Select complete chapters totaling at least one page.");
  const guide = await captured.readers.loadStyleGuide(work.id);
  // An absent guide is synthesized with fresh top-level timestamps on each read.
  // Bind its content; the native writer still preserves its complete captured guide.
  const {
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...guideContent
  } = guide;
  const snapshot = hashStableValue({
    format: "mgtshare-v1",
    work: { id: work.id, title: work.title, chapterOrder: work.chapterOrder },
    chapterIds,
    chapters,
    guide: guideContent,
  });
  return {
    chapters,
    entryCount,
    metadata: {
      workId: work.id,
      workTitle: work.title,
      chapterIds,
      snapshot,
      format: "mgtshare-v1" as const,
      chapterCount: chapters.length,
      pageCount,
      blockCount,
      chapters: chapters.map(describeChapter),
    },
  };
}

function selectedChapterIds(
  input: McpWorkFileExportReviewInput,
  work: Awaited<ReturnType<Captured["readers"]["loadWork"]>>,
) {
  const chapterIds = work.chapterOrder.filter((id) =>
    input.chapterIds.includes(id),
  );
  if (
    work.id !== input.workId ||
    chapterIds.length !== input.chapterIds.length ||
    new Set(input.chapterIds).size !== input.chapterIds.length ||
    !chapterIds.length ||
    chapterIds.length > 10
  )
    throw invalid("Select one to ten distinct chapters from this work.");
  return chapterIds;
}

function describeChapter(chapter: Chapter) {
  return {
    chapterId: chapter.id,
    title: chapter.title,
    pageCount: chapter.pages.length,
    blockCount: chapter.pages.reduce(
      (sum, page) => sum + page.blocks.length,
      0,
    ),
    processedPageCount: chapter.pages.filter((page) => page.inpaintedImagePath)
      .length,
    pages: reorderRecords(chapter.pages, chapter.pageOrder).map((page) => ({
      pageId: page.id,
      revision: createPageRevision(page),
    })),
  };
}

function assertBinding(
  binding: McpWorkFileExportBinding,
  actual: McpWorkFileExportBinding,
) {
  if (
    binding.snapshot !== actual.snapshot ||
    binding.workId !== actual.workId ||
    binding.chapterIds.length !== actual.chapterIds.length ||
    binding.chapterIds.some((id, index) => id !== actual.chapterIds[index])
  )
    throw new McpEditError(
      "revision_conflict",
      "Working-file metadata, guide or selection changed; repeat export preflight.",
    );
}
function invalid(message: string) {
  return new McpEditError("invalid_edit", message);
}
