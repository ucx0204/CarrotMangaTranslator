import { parse } from "node:path";
import type { LinkedWorkspaceRecordV1 } from "../../shared/linkedWorkspaceTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import {
  REVIEWED_OUTPUT_LIMITS,
  ReviewedOutputError,
  type ReviewedOutputDigest,
  type ReviewedOutputSelection,
} from "./linkedWorkspaceReviewedOutputTypes";
import type {
  ReviewedNativeInput,
  ReviewedSource,
} from "./linkedWorkspaceReviewedOutputInternal";
import {
  resolvePathInside,
  normalizeLinkedRelativePath,
} from "./linkedWorkspacePaths";
import {
  assertReviewedPath,
  assertReviewedDigest,
  readReviewedFile,
  reviewedPathKey,
} from "./linkedWorkspaceReviewedOutputEvidence";

export async function captureReviewedSources(
  input: ReviewedNativeInput,
  guard: () => void,
) {
  const sources: ReviewedSource[] = [];
  for (const chapter of input.chapters) {
    const record = input.records.find((item) => item.chapterId === chapter.id);
    if (!record) throw new ReviewedOutputError("selection_changed");
    for (const page of chapter.pages) {
      guard();
      await capturePageSources(input, record, page, sources);
    }
  }
  guard();
  return sources;
}

async function capturePageSources(
  input: ReviewedNativeInput,
  record: LinkedWorkspaceRecordV1,
  page: MangaPage,
  sources: ReviewedSource[],
) {
  const original = await addSource(
    sources,
    record.chapterId,
    page.id,
    page.imagePath,
  );
  const relative =
    record.sourceRelativePaths?.[page.id] ?? record.pageRelativePaths[page.id];
  const expected = record.sourceFingerprints[page.id];
  if (!relative || !expected) throw new ReviewedOutputError("source_changed");
  const copyPath = resolvePathInside(input.rootPath, relative);
  await assertReviewedPath(input.rootPath, copyPath);
  const copy = await addSource(sources, record.chapterId, page.id, copyPath);
  assertReviewedDigest(copy, { bytes: expected.size, sha256: expected.sha256 });
  assertReviewedDigest(copy, original);
  for (const path of [page.inpaintedImagePath, page.inpaintMaskPath]) {
    if (path) await addSource(sources, record.chapterId, page.id, path);
  }
}

async function addSource(
  sources: ReviewedSource[],
  chapterId: string,
  pageId: string,
  path: string,
): Promise<ReviewedOutputDigest> {
  await assertReviewedPath(parse(path).root, path);
  const digest = await readReviewedFile(
    path,
    false,
    REVIEWED_OUTPUT_LIMITS.imageBytes,
  );
  if (!digest) throw new ReviewedOutputError("source_changed");
  sources.push({ chapterId, pageId, path, digest });
  return digest;
}

export async function captureReviewedTargets(
  input: ReviewedNativeInput,
  selection: ReviewedOutputSelection,
  guard: () => void,
): Promise<Map<string, ReviewedOutputDigest | null>> {
  const targets = new Map<string, ReviewedOutputDigest | null>();
  for (const record of input.records) {
    const chapter = input.chapters.find(
      (chapter) => chapter.id === record.chapterId,
    );
    if (!chapter) throw new ReviewedOutputError("selection_changed");
    for (const page of chapter.pages) {
      const selected =
        record.chapterId === selection.chapterId &&
        selection.pageIds.includes(page.id);
      await capturePageTargets(
        input,
        record.artifacts[page.id],
        selected,
        targets,
        guard,
      );
    }
  }
  return targets;
}

async function capturePageTargets(
  input: ReviewedNativeInput,
  artifacts: LinkedWorkspaceRecordV1["artifacts"][string] | undefined,
  selected: boolean,
  targets: Map<string, ReviewedOutputDigest | null>,
  guard: () => void,
) {
  for (const [role, artifact] of Object.entries(artifacts ?? {})) {
    if (!artifact) continue;
    const relative = normalizeLinkedRelativePath(artifact.path);
    if (!relative.startsWith(role + "/"))
      throw new ReviewedOutputError("unsafe_path");
    const path = resolvePathInside(input.rootPath, relative);
    guard();
    await assertReviewedPath(input.rootPath, path);
    const actual = await readReviewedFile(
      path,
      true,
      REVIEWED_OUTPUT_LIMITS.imageBytes,
    );
    if (!selected)
      assertReviewedDigest(actual, {
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      });
    targets.set(reviewedPathKey(path), actual);
  }
}

export function artifactOwners(
  records: LinkedWorkspaceRecordV1[],
  relative: string,
) {
  const key = normalizeLinkedRelativePath(relative).toLowerCase();
  return records.flatMap((record) =>
    Object.entries(record.artifacts).flatMap(([pageId, artifacts]) =>
      Object.entries(artifacts).flatMap(([role, artifact]) =>
        artifact &&
        normalizeLinkedRelativePath(artifact.path).toLowerCase() === key
          ? [{ recordId: record.id, pageId, role }]
          : [],
      ),
    ),
  );
}

export function assertNotSourceTarget(path: string, sources: ReviewedSource[]) {
  if (
    sources.some(
      (source) => reviewedPathKey(source.path) === reviewedPathKey(path),
    )
  )
    throw new ReviewedOutputError("unmanaged_collision");
}
