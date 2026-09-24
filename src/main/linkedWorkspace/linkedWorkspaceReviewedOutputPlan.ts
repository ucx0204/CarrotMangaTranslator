import { hashStableValue } from "../../shared/blockFingerprint";
import {
  createPageRevision,
  createPageVisualRevision,
} from "../../shared/pageRevision";
import { buildLinkedMirrorChapter } from "./linkedWorkspaceMirror";
import { createLinkedWorkspaceMirrorPayload } from "./linkedWorkspaceFiles";
import { serializeJsonFile } from "../libraryStore/storage";
import { resolvePathInside } from "./linkedWorkspacePaths";
import { reviewedPathKey } from "./linkedWorkspaceReviewedOutputEvidence";
import {
  readReviewedInput,
  canonicalSelection,
} from "./linkedWorkspaceReviewedOutputInput";
import {
  captureReviewedSources,
  captureReviewedTargets,
} from "./linkedWorkspaceReviewedOutputSources";
import {
  planReviewedMirror,
  planReviewedPage,
} from "./linkedWorkspaceReviewedOutputFiles";
import {
  REVIEWED_OUTPUT_LIMITS,
  ReviewedOutputError,
  type ReviewedOutputSelection,
} from "./linkedWorkspaceReviewedOutputTypes";
import type {
  NativeLinkedOutputOwner,
  ReviewedNativePlan,
  ReviewedNativeInput,
  ReviewedNativePage,
} from "./linkedWorkspaceReviewedOutputInternal";

export async function prepareReviewedOutput(
  owner: NativeLinkedOutputOwner,
  selection: ReviewedOutputSelection,
  guard: () => void,
): Promise<ReviewedNativePlan> {
  const input = await readReviewedInput(owner, selection, guard);
  const pageIds = canonicalSelection(input.chapters, selection);
  const chapter = input.chapters.find(
    (item) => item.id === selection.chapterId,
  );
  const record = input.records.find(
    (item) => item.id === selection.connectionId,
  );
  if (!chapter || !record) throw new ReviewedOutputError("selection_changed");
  const sources = await captureReviewedSources(input, guard);
  const targets = await captureReviewedTargets(input, selection, guard);
  const pages: ReviewedNativePage[] = [];
  for (const page of chapter.pages.filter((page) =>
    pageIds.includes(page.id),
  )) {
    guard();
    pages.push(await planReviewedPage(input, record, page, sources));
  }
  const mirror = await planReviewedMirror(input);
  const files = [...pages.flatMap((page) => page.files), mirror];
  assertDistinctFiles(files);
  for (const file of files) {
    if (file.relativePath)
      targets.set(
        reviewedPathKey(resolvePathInside(input.rootPath, file.relativePath)),
        file.previous,
      );
  }
  assertMirrorSize(owner, input, pages);
  const fresh = await readReviewedInput(owner, selection, guard);
  if (
    input.selectionSnapshot !== fresh.selectionSnapshot ||
    input.destinationSnapshot !== fresh.destinationSnapshot ||
    hashStableValue(input.records) !== hashStableValue(fresh.records)
  )
    throw new ReviewedOutputError("selection_changed");
  guard();
  const plan = { ...input, pages, sources, targets, files };
  return { ...plan, review: createReview(plan, selection, pageIds) };
}

function createReview(
  plan: Omit<ReviewedNativePlan, "review">,
  selection: ReviewedOutputSelection,
  pageIds: string[],
): ReviewedNativePlan["review"] {
  return {
    chapterId: selection.chapterId,
    connectionId: selection.connectionId,
    pageIds,
    selectionSnapshot: plan.selectionSnapshot,
    destinationSnapshot: plan.destinationSnapshot,
    sourceSnapshot: hashStableValue({
      sources: plan.sources,
      targets: [...plan.targets.entries()],
      records: plan.records,
      files: plan.files.map(({ sourcePath, relativePath, ...file }) => ({
        ...file,
        sourcePath,
        relativePath,
      })),
    }),
    pages: plan.pages.map(({ page, captureFormat }) => ({
      pageId: page.id,
      revision: createPageRevision(page),
      visualRevision: createPageVisualRevision(page),
      format: captureFormat,
    })),
    mirrorScope: reviewedMirrorScope(plan),
    files: plan.files.map(
      ({
        relativePath: _path,
        sourcePath: _source,
        desired: _desired,
        ...file
      }) => file,
    ),
    limits: REVIEWED_OUTPUT_LIMITS,
    registryPublications: {
      maximum: plan.pages.length + 1,
      privateMetadataOnly: true,
    },
    executionReserved: false,
    partialPublication: true,
  };
}

export function reviewedMirrorScope(input: ReviewedNativeInput) {
  return {
    chapters: input.records.map((record) => ({
      connectionId: record.id,
      chapterId: record.chapterId,
      pageIds:
        input.chapters
          .find((chapter) => chapter.id === record.chapterId)
          ?.pages.map((page) => page.id) ?? [],
    })),
    pageCount: input.chapters.reduce(
      (sum, chapter) => sum + chapter.pages.length,
      0,
    ),
    includesSavedText: true as const,
  };
}

function assertDistinctFiles(files: ReviewedNativePlan["files"]) {
  if (
    files.length > REVIEWED_OUTPUT_LIMITS.externalFiles ||
    files.some((file) => !/^[A-Za-z0-9:_-]{1,128}$/.test(file.fileId))
  )
    throw new ReviewedOutputError("limit_exceeded");
  const paths = files.map((file) => file.relativePath?.toLowerCase());
  if (new Set(paths).size !== paths.length)
    throw new ReviewedOutputError("unmanaged_collision");
}

function assertMirrorSize(
  owner: NativeLinkedOutputOwner,
  input: ReviewedNativeInput,
  pages: ReviewedNativePage[],
) {
  const chapters = maximumMirrorRecords(input, pages).map((record) => {
    const chapter = input.chapters.find((item) => item.id === record.chapterId);
    if (!chapter) throw new ReviewedOutputError("selection_changed");
    return buildLinkedMirrorChapter(
      record,
      chapter,
      input.workTitles.get(record.workId) ?? "",
    );
  });
  const bytes = Buffer.byteLength(
    serializeJsonFile(
      createLinkedWorkspaceMirrorPayload(owner.appVersion(), chapters),
    ),
  );
  if (bytes > REVIEWED_OUTPUT_LIMITS.mirrorBytes)
    throw new ReviewedOutputError("limit_exceeded");
}

function maximumMirrorRecords(
  input: ReviewedNativeInput,
  pages: ReviewedNativePage[],
) {
  const records = structuredClone(input.records);
  for (const item of pages) {
    const record = records.find((record) => record.id === item.recordId);
    if (!record) throw new ReviewedOutputError("selection_changed");
    const artifacts = { ...record.artifacts[item.page.id] };
    for (const file of item.files) {
      if (
        file.action !== "publish" ||
        file.role === "registry" ||
        file.role === "mirror" ||
        !file.relativePath
      )
        continue;
      artifacts[file.role] = {
        path: file.relativePath,
        bytes: file.desired?.bytes ?? REVIEWED_OUTPUT_LIMITS.imageBytes,
        sha256: "0".repeat(64),
      };
    }
    if (!item.page.inpaintedImagePath) delete artifacts.inpainted;
    if (!item.page.inpaintMaskPath) delete artifacts.mask;
    record.artifacts[item.page.id] = artifacts;
  }
  return records;
}
