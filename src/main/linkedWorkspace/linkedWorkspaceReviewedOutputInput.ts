import { resolve } from "node:path";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  createPageRevision,
  createPageVisualRevision,
} from "../../shared/pageRevision";
import type { ChapterSnapshot } from "../../shared/libraryTypes";
import type { LinkedWorkspaceRecordV1 } from "../../shared/linkedWorkspaceTypes";
import { withLibraryRead } from "../library/lock";
import { resolvePathInside } from "./linkedWorkspacePaths";
import {
  reviewedPathKey,
  reviewedRootIdentity,
  assertReviewedPath,
} from "./linkedWorkspaceReviewedOutputEvidence";
import {
  REVIEWED_OUTPUT_LIMITS,
  ReviewedOutputError,
  type ReviewedOutputSelection,
} from "./linkedWorkspaceReviewedOutputTypes";
import type {
  NativeLinkedOutputOwner,
  ReviewedNativeInput,
} from "./linkedWorkspaceReviewedOutputInternal";

export async function readReviewedInput(
  owner: NativeLinkedOutputOwner,
  selection: ReviewedOutputSelection,
  guard: () => void,
): Promise<ReviewedNativeInput> {
  const destination = await readCurrentRoot(owner, selection, guard);
  const { rootPath, records: shared } = destination;
  const { chapters, workTitles, membership } = await readChapters(
    owner,
    shared,
  );
  validateSelection(chapters, selection);
  for (const [index, chapter] of chapters.entries())
    validateChapter(owner, shared[index], chapter);
  guard();
  assertReviewedRecords(
    shared,
    owner
      .records()
      .filter(
        (item) => reviewedPathKey(item.rootPath) === reviewedPathKey(rootPath),
      ),
  );
  return {
    ...destination,
    chapters,
    workTitles,
    selectionSnapshot: hashStableValue({
      membership,
      chapters: chapters.map((chapter) => chapterBinding(chapter, workTitles)),
      selected: canonicalSelection(chapters, selection),
    }),
  };
}

async function readCurrentRoot(
  owner: NativeLinkedOutputOwner,
  selection: ReviewedOutputSelection,
  guard: () => void,
) {
  guard();
  if (!owner.available())
    throw new ReviewedOutputError("destination_unavailable");
  const records = owner.records();
  const selected = records.find((item) => item.id === selection.connectionId);
  if (
    !selected ||
    selected.chapterId !== selection.chapterId ||
    !selected.enabled
  )
    throw new ReviewedOutputError("destination_unavailable");
  const rootPath = resolve(selected.rootPath);
  const shared = records.filter(
    (item) => reviewedPathKey(item.rootPath) === reviewedPathKey(rootPath),
  );
  if (shared.length > REVIEWED_OUTPUT_LIMITS.mirrorChapters)
    throw new ReviewedOutputError("limit_exceeded");
  if (shared.some((record) => !record.destinationKind))
    throw new ReviewedOutputError("legacy_preparation_required");
  const stored = (await owner.storedRecords()).filter(
    (item) => reviewedPathKey(item.rootPath) === reviewedPathKey(rootPath),
  );
  assertReviewedRecords(shared, stored);
  await assertReviewedPath(
    rootPath,
    resolvePathInside(rootPath, ".review-probe"),
  );
  const rootIdentity = await reviewedRootIdentity(rootPath);
  return {
    rootPath,
    rootIdentity,
    records: shared,
    destinationSnapshot: hashStableValue({
      rootIdentity,
      records: shared.map(destinationRecord),
    }),
  };
}

async function readChapters(
  owner: NativeLinkedOutputOwner,
  records: LinkedWorkspaceRecordV1[],
) {
  return withLibraryRead(async () => {
    const library = await owner.listLibrary();
    const chapters: ChapterSnapshot[] = [];
    for (const record of records)
      chapters.push(await owner.openChapter(record.chapterId));
    for (const record of records) {
      const work = library.works.find((work) => work.id === record.workId);
      if (
        !work ||
        !work.chapters.some((chapter) => chapter.id === record.chapterId) ||
        !work.chapterOrder.includes(record.chapterId)
      )
        throw new ReviewedOutputError("selection_changed");
    }
    const workIds = new Set(records.map((record) => record.workId));
    return {
      chapters,
      workTitles: new Map(library.works.map((work) => [work.id, work.title])),
      membership: library.works
        .filter((work) => workIds.has(work.id))
        .map((work) => ({
          id: work.id,
          title: work.title,
          chapterOrder: work.chapterOrder,
          chapters: work.chapters.map(({ id, workId }) => ({ id, workId })),
        })),
    };
  });
}

function validateSelection(
  chapters: ChapterSnapshot[],
  selection: ReviewedOutputSelection,
) {
  const selected = canonicalSelection(chapters, selection);
  if (
    !selection.pageIds.length ||
    selection.pageIds.length > REVIEWED_OUTPUT_LIMITS.selectedPages ||
    new Set(selection.pageIds).size !== selection.pageIds.length ||
    selected.length !== selection.pageIds.length ||
    chapters.reduce((sum, chapter) => sum + chapter.pages.length, 0) >
      REVIEWED_OUTPUT_LIMITS.mirrorPages
  )
    throw new ReviewedOutputError("limit_exceeded");
}

function validateChapter(
  owner: NativeLinkedOutputOwner,
  record: LinkedWorkspaceRecordV1 | undefined,
  chapter: ChapterSnapshot,
) {
  if (
    !record ||
    chapter.workId !== record.workId ||
    new Set(chapter.pages.map((page) => page.id)).size !==
      chapter.pages.length ||
    hashStableValue(chapter.pageOrder) !==
      hashStableValue(chapter.pages.map((page) => page.id))
  )
    throw new ReviewedOutputError("selection_changed");
  if (
    hashStableValue(owner.allocate(record, chapter)) !== hashStableValue(record)
  )
    throw new ReviewedOutputError("destination_changed");
}

export function canonicalSelection(
  chapters: ChapterSnapshot[],
  selection: ReviewedOutputSelection,
) {
  const selected = new Set(selection.pageIds);
  return (
    chapters
      .find((chapter) => chapter.id === selection.chapterId)
      ?.pages.filter((page) => selected.has(page.id))
      .map((page) => page.id) ?? []
  );
}

function chapterBinding(
  chapter: ChapterSnapshot,
  workTitles: Map<string, string>,
) {
  return {
    id: chapter.id,
    workId: chapter.workId,
    workTitle: workTitles.get(chapter.workId) ?? "",
    title: chapter.title,
    pageOrder: chapter.pageOrder,
    pages: chapter.pages.map((page) => ({
      id: page.id,
      revision: createPageRevision(page),
      visualRevision: createPageVisualRevision(page),
      name: page.name,
      sourceFileName: page.sourceFileName,
      sourceRelativePath: page.sourceRelativePath,
      imagePath: page.imagePath,
      inpaintedImagePath: page.inpaintedImagePath,
      inpaintMaskPath: page.inpaintMaskPath,
    })),
  };
}

function destinationRecord(record: LinkedWorkspaceRecordV1) {
  return {
    id: record.id,
    workId: record.workId,
    chapterId: record.chapterId,
    rootPath: record.rootPath,
    destinationKind: record.destinationKind,
    enabled: record.enabled,
    output: record.output,
    pageRelativePaths: record.pageRelativePaths,
    resultRelativePaths: record.resultRelativePaths,
    sourceRelativePaths: record.sourceRelativePaths,
    sourceFingerprints: record.sourceFingerprints,
  };
}

export function assertReviewedRecords(
  left: LinkedWorkspaceRecordV1[],
  right: LinkedWorkspaceRecordV1[],
) {
  const ordered = (records: LinkedWorkspaceRecordV1[]) =>
    [...records].sort((a, b) => a.id.localeCompare(b.id));
  if (hashStableValue(ordered(left)) !== hashStableValue(ordered(right)))
    throw new ReviewedOutputError("destination_changed");
}
