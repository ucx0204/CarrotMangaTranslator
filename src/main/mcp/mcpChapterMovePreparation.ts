import { hashStableValue } from "../../shared/blockFingerprint";
import type { McpChapterMoveIntent } from "../../shared/mcpChapterMove";
import type { ChapterMoveFrame } from "../application/mcpChapterMoveState";
import { McpEditError } from "../application/mcpEditPolicy";
import { makeUniqueChapterTitle } from "../libraryStore/libraryFiles";
import { readLibraryPageOrdering } from "../libraryStore/libraryPageOrdering";
import { prepareChapterDeletionUnlocked } from "../libraryStore/libraryChapterDeletion";
import { nextChapterUpdatedAt } from "../libraryStore/chapterRecords";
import { prepareChapterMoveContent } from "./mcpChapterMoveContent";
import { readChapterMoveState } from "./mcpChapterMoveSnapshot";
export async function prepareChapterMove(
  intent: McpChapterMoveIntent,
  guard: () => void,
) {
  const state = await readChapterMoveState(intent, guard);
  const chapter = state.left.chapter;
  if (!chapter || state.moved)
    throw new McpEditError(
      "revision_conflict",
      "The source work no longer owns the chapter.",
    );
  const destinationOrder = [...state.right.work.chapterOrder];
  const index =
    intent.beforeChapterId === undefined
      ? destinationOrder.length
      : destinationOrder.indexOf(intent.beforeChapterId);
  if (index < 0 || destinationOrder.length >= 2000)
    throw new McpEditError(
      "invalid_edit",
      "Destination insertion anchor is missing or the work is full.",
    );
  destinationOrder.splice(index, 0, chapter.id);
  const title = await makeUniqueChapterTitle(
    intent.destinationWorkId,
    chapter.title,
  );
  const ordering = await readLibraryPageOrdering(chapter);
  const now = nextChapterUpdatedAt(chapter);
  const content = prepareChapterMoveContent(
    intent,
    chapter,
    ordering.memory,
    state.guides,
    state.tree,
    title,
    now,
  );
  const removed = await prepareChapterDeletionUnlocked(
    intent.workId,
    intent.chapterId,
  );
  if (hashStableValue(removed.work) !== hashStableValue(state.left.work))
    throw new McpEditError(
      "revision_conflict",
      "Source work changed during move preparation.",
    );
  const after: ChapterMoveFrame = {
    ...state.frame,
    works: [
      { ...removed.after, updatedAt: now },
      { ...state.right.work, chapterOrder: destinationOrder, updatedAt: now },
    ],
  };
  const visible = movementReviewValues(state, after, content, chapter.title);
  guard();
  return {
    state,
    after,
    content,
    review: {
      intent,
      snapshot: state.snapshot,
      planFingerprint: hashStableValue({
        intent,
        snapshot: state.snapshot,
        visible,
      }),
      ...visible,
      warnings: [
        "existing_chapter_id_and_artwork_preserved; source_work_kept_even_when_empty",
        "destination_rules_and_reading_direction_apply_after_move",
        "catalogs_are_not_merged; unresolved_references_require_explicit_mapping",
        "internal_translation_and_font_continuity_checkpoints_invalidated; original_files_retained_for_undo",
        "older_jobs_reviews_outputs_and_histories_remain_bound_to_their_original_work",
        "target_must_be_closed_and_unlinked; no_network_or_model_execution",
        "recovery_expires_after_seven_days; ordinary_moved_chapter_does_not_expire",
      ],
    },
  };
}

function movementReviewValues(
  state: Awaited<ReturnType<typeof readChapterMoveState>>,
  after: ChapterMoveFrame,
  content: ReturnType<typeof prepareChapterMoveContent>,
  beforeTitle: string,
) {
  return {
    eligible: content.issues.length === 0,
    sourceWorkTitle: state.left.work.title,
    destinationWorkTitle: state.right.work.title,
    beforeTitle,
    afterTitle: content.chapter.title,
    sourceChapterIds: after.works[0].chapterOrder,
    destinationChapterIds: after.works[1].chapterOrder,
    pageCount: content.chapter.pages.length,
    sourceBytes: state.tree.files.reduce((sum, file) => sum + file.bytes, 0),
    fileCount: state.tree.files.length,
    memoryPresent: content.memory !== null,
    referenceIssues: content.issues,
    mappedReferences: content.mappedReferences,
    invalidatedCheckpoints: content.invalidatedCheckpoints,
  };
}
