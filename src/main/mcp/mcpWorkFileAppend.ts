import { hashStableValue } from "../../shared/blockFingerprint";
import {
  McpWorkFileAppendReviewSchema,
  mcpWorkFileOutputs,
  type McpWorkFileAppendReview,
  type McpWorkFileCreate,
} from "../../shared/mcpWorkFileImport";
import type { LibraryChapter } from "../../shared/libraryTypes";
import type { WorkStyleGuide } from "../../shared/workContextTypes";
import { McpEditError } from "../application/mcpEditPolicy";
import { planChapterMoveReferences } from "../application/mcpChapterMoveReferences";
import { withLibraryRead } from "../library/lock";
import { readShareAppendTarget } from "../libraryStore/shareAppendWorkflow";
import { readWorkStyleGuide } from "../libraryStore/workContextFiles";
import { makeUniqueTitleInList, sanitizeTitle } from "../libraryStore/titles";
import { tMain } from "../libraryStore/localization";
import {
  selectWorkFileChapters,
  type WorkFileAsset,
} from "./mcpWorkFileSource";

async function destination(workId: string, guard: () => void) {
  guard();
  const state = await readShareAppendTarget(workId);
  const guide = await readWorkStyleGuide(workId);
  // An absent guide receives transient native timestamps; they do not change its meaning.
  const { createdAt: _created, updatedAt: _updated, ...semanticGuide } = guide;
  guard();
  return {
    ...state,
    guide,
    version: hashStableValue([state.snapshot, semanticGuide]),
  };
}

/** No catalog merge, no model call, and no update of existing chapter content. */
export async function reviewWorkFileAppend(
  raw: McpWorkFileAppendReview,
  asset: WorkFileAsset,
  guard: () => void,
) {
  const input = McpWorkFileAppendReviewSchema.parse(raw);
  selectWorkFileChapters(input, asset.review);
  const state = await withLibraryRead(() =>
    destination(input.target.workId, guard),
  );
  if (state.work.chapterOrder.length + input.chapters.length > 2000)
    throw new McpEditError(
      "invalid_edit",
      "The destination cannot exceed 2,000 chapters.",
    );
  const selected = input.chapters.map(({ packageChapterId }) => {
    const found = asset.chapters.find(
      (chapter) => chapter.id === packageChapterId,
    );
    if (!found)
      throw new McpEditError(
        "invalid_edit",
        "Selected package chapter is absent.",
      );
    return found;
  });
  const references = mapSelectedReferences(
    selected,
    asset.styleGuide,
    state.guide,
    input.target.references ?? [],
  );
  const review = appendReview(input, state, selected, references);
  guard();
  return {
    review,
    verify: async () => {
      // Called inside the native write boundary; do not re-acquire its read lock.
      if (
        (await destination(input.target.workId, guard)).version !==
        state.version
      )
        throw new McpEditError(
          "revision_conflict",
          "Append destination or context changed. Review again.",
        );
    },
    mapChapter: (chapter: LibraryChapter) => {
      const index = selected.findIndex((item) => item.id === chapter.id);
      if (
        index < 0 ||
        hashStableValue(chapter) !== hashStableValue(selected[index])
      )
        throw new McpEditError(
          "revision_conflict",
          "Native input differs from the reviewed chapter.",
        );
      return structuredClone(references.chapters[index]);
    },
  };
}

function appendReview(
  input: McpWorkFileAppendReview,
  state: Awaited<ReturnType<typeof destination>>,
  selected: LibraryChapter[],
  references: ReturnType<typeof mapSelectedReferences>,
) {
  const titles = new Set(state.titles);
  const chapters = input.chapters.map((chapter, index) => {
    const title = makeUniqueTitleInList(
      sanitizeTitle(chapter.title, tMain("import.untitled")),
      titles,
    );
    titles.add(title);
    return {
      packageChapterId: chapter.packageChapterId,
      title,
      pageCount: selected[index].pages.length,
    };
  });
  return mcpWorkFileOutputs.carrot_preview_work_file_append.parse({
    uploadId: input.uploadId,
    snapshot: input.snapshot,
    target: {
      ...input.target,
      mode: "append",
      snapshot: hashStableValue([input, state.version, chapters]),
    },
    workTitle: state.work.title,
    preservedChapterCount: state.work.chapterOrder.length,
    chapters,
    eligible: references.issues.length === 0,
    referenceIssues: references.issues,
    mappedReferences: references.mappedReferences,
    warnings: [
      "append_selected_complete_chapters_at_end;existing_chapters_are_not_rewritten",
      "destination_guide_rules_and_reading_direction_remain_authoritative",
      "package_guide_is_not_merged;resolve_references_or_edit_context_separately",
      "same_reference_id_requires_matching_definition_unless_explicitly_mapped",
      "keep_live_upload_until_import_settles;v1_memory_mask_history_limits_still_apply",
      "no_ocr_translation_research_or_output_sync",
    ],
  });
}

export async function prepareWorkFileAppend(
  input: McpWorkFileCreate,
  asset: WorkFileAsset,
  guard: () => void,
) {
  if (input.target.mode !== "append") return undefined;
  const { mode: _mode, snapshot, ...target } = input.target;
  const plan = await reviewWorkFileAppend(
    {
      uploadId: input.uploadId,
      snapshot: input.snapshot,
      chapters: input.chapters,
      target,
    },
    asset,
    guard,
  );
  if (snapshot !== plan.review.target.snapshot)
    throw new McpEditError(
      "revision_conflict",
      "Append selection, mappings or destination changed after review.",
    );
  if (!plan.review.eligible)
    throw new McpEditError(
      "invalid_edit",
      "Resolve the reviewed reference conflicts before append. No chapters were saved.",
    );
  return plan;
}

function mapSelectedReferences(
  chapters: LibraryChapter[],
  source: WorkStyleGuide | undefined,
  destinationGuide: WorkStyleGuide,
  mappings: NonNullable<McpWorkFileAppendReview["target"]["references"]>,
) {
  const sourceGuide = source ?? {
    ...destinationGuide,
    glossary: [],
    characters: [],
  };
  const plans = chapters.map((chapter) =>
    planChapterMoveReferences(
      chapter,
      null,
      sourceGuide,
      destinationGuide,
      mappings,
    ),
  );
  const key = (item: { kind: string; sourceId: string }) =>
    `${item.kind}/${item.sourceId}`;
  const unused = new Set(mappings.map(key));
  const issues = new Map<string, (typeof plans)[number]["issues"][number]>();
  for (const plan of plans) {
    const localUnused = new Set(
      plan.issues.filter((issue) => issue.reason === "unused-mapping").map(key),
    );
    for (const item of unused) if (!localUnused.has(item)) unused.delete(item);
    for (const issue of plan.issues)
      if (issue.reason !== "unused-mapping") issues.set(key(issue), issue);
  }
  for (const mapping of mappings)
    if (unused.has(key(mapping)))
      issues.set(key(mapping), {
        kind: mapping.kind,
        sourceId: mapping.sourceId,
        reason: "unused-mapping",
      });
  if (issues.size > 2000)
    throw new McpEditError(
      "invalid_edit",
      "Append reference inventory exceeds 2,000 issues.",
    );
  return {
    chapters: plans.map((plan) => plan.chapter),
    issues: [...issues.values()],
    mappedReferences: plans.reduce(
      (sum, plan) => sum + plan.mappedReferences,
      0,
    ),
  };
}
