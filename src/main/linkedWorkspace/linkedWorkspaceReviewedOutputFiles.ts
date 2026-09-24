import type { MangaPage } from "../../shared/libraryTypes";
import type { LinkedWorkspaceRecordV1 } from "../../shared/linkedWorkspaceTypes";
import {
  buildLinkedMirrorFileName,
  hasStemCollision,
  resolveLinkedPngArtifactPath,
  resolveLinkedResultPath,
  resolvePathInside,
  relativePathFromRoot,
  normalizeLinkedRelativePath,
} from "./linkedWorkspacePaths";
import {
  assertReviewedPath,
  readReviewedFile,
  readReviewedJson,
} from "./linkedWorkspaceReviewedOutputEvidence";
import {
  artifactOwners,
  assertNotSourceTarget,
} from "./linkedWorkspaceReviewedOutputSources";
import {
  REVIEWED_OUTPUT_LIMITS,
  ReviewedOutputError,
} from "./linkedWorkspaceReviewedOutputTypes";
import type {
  ReviewedNativeFile,
  ReviewedNativeInput,
  ReviewedNativePage,
  ReviewedSource,
} from "./linkedWorkspaceReviewedOutputInternal";

export async function planReviewedPage(
  input: ReviewedNativeInput,
  record: LinkedWorkspaceRecordV1,
  page: MangaPage,
  sources: ReviewedSource[],
): Promise<ReviewedNativePage> {
  if (page.inpaintedImagePath && !page.inpaintMaskPath)
    throw new ReviewedOutputError("legacy_preparation_required");
  const source = record.pageRelativePaths[page.id];
  const result = record.resultRelativePaths?.[page.id];
  if (!source || !result) throw new ReviewedOutputError("destination_changed");
  const { captureFormat } = resolveLinkedResultPath({
    rootPath: input.rootPath,
    sourceRelativePath: source,
    format: record.output.format,
  });
  const files: ReviewedNativeFile[] = [];
  await planRole(input, record, page, "result", result, null, sources, files);
  for (const role of ["inpainted", "mask"] as const) {
    const sourcePath =
      role === "inpainted" ? page.inpaintedImagePath : page.inpaintMaskPath;
    const relative = sourcePath
      ? relativePathFromRoot(
          input.rootPath,
          resolveLinkedPngArtifactPath({
            rootPath: input.rootPath,
            directory: role,
            sourceRelativePath: source,
            disambiguateExtension: hasStemCollision(record, page.id, source),
          }),
        )
      : null;
    await planRole(
      input,
      record,
      page,
      role,
      relative,
      sourcePath ?? null,
      sources,
      files,
    );
  }
  return { page, recordId: record.id, captureFormat, files };
}

async function planRole(
  input: ReviewedNativeInput,
  record: LinkedWorkspaceRecordV1,
  page: MangaPage,
  role: "result" | "inpainted" | "mask",
  relative: string | null,
  sourcePath: string | null,
  sources: ReviewedSource[],
  files: ReviewedNativeFile[],
) {
  relative = relative ? normalizeLinkedRelativePath(relative) : null;
  if (relative)
    files.push(
      await planRolePublication(
        input,
        record,
        page,
        role,
        relative,
        sourcePath,
        sources,
      ),
    );
  await planRoleRemoval(input, record, page, role, relative, sources, files);
}

async function planRolePublication(
  input: ReviewedNativeInput,
  record: LinkedWorkspaceRecordV1,
  page: MangaPage,
  role: "result" | "inpainted" | "mask",
  relative: string,
  sourcePath: string | null,
  sources: ReviewedSource[],
): Promise<ReviewedNativeFile> {
  const previous = await reviewedAllocation(
    input,
    record.id,
    page.id,
    role,
    relative,
    sources,
  );
  const desired = sourcePath
    ? sources.find((source) => source.path === sourcePath)?.digest
    : null;
  if (sourcePath && !desired) throw new ReviewedOutputError("source_changed");
  return {
    fileId: role + ":" + page.id + ":publish",
    role,
    pageId: page.id,
    action: "publish",
    previous,
    relativePath: relative,
    sourcePath,
    desired: desired ?? null,
  };
}

async function planRoleRemoval(
  input: ReviewedNativeInput,
  record: LinkedWorkspaceRecordV1,
  page: MangaPage,
  role: "result" | "inpainted" | "mask",
  relative: string | null,
  sources: ReviewedSource[],
  files: ReviewedNativeFile[],
) {
  const previousPath = record.artifacts[page.id]?.[role]?.path;
  const old = previousPath
    ? normalizeLinkedRelativePath(previousPath)
    : undefined;
  if (!old || old.toLowerCase() === relative?.toLowerCase()) return;
  const owners = artifactOwners(input.records, old);
  if (
    owners.some(
      (owner) =>
        owner.recordId !== record.id ||
        owner.pageId !== page.id ||
        owner.role !== role,
    )
  )
    throw new ReviewedOutputError("unmanaged_collision");
  if (
    input.records.some((candidate) =>
      Object.values(candidate.resultRelativePaths ?? {}).some(
        (path) => path.toLowerCase() === old.toLowerCase(),
      ),
    )
  )
    return;
  const previous = await reviewedAllocation(
    input,
    record.id,
    page.id,
    role,
    old,
    sources,
  );
  if (previous)
    files.push({
      fileId: role + ":" + page.id + ":remove",
      role,
      pageId: page.id,
      action: "remove",
      previous,
      relativePath: old,
      sourcePath: null,
      desired: null,
    });
}

async function reviewedAllocation(
  input: ReviewedNativeInput,
  recordId: string,
  pageId: string,
  role: string,
  relative: string,
  sources: ReviewedSource[],
) {
  if (!relative.startsWith(role + "/"))
    throw new ReviewedOutputError("unsafe_path");
  const path = resolvePathInside(input.rootPath, relative);
  assertNotSourceTarget(path, sources);
  await assertReviewedPath(input.rootPath, path);
  const owners = artifactOwners(input.records, relative);
  if (
    owners.some(
      (owner) =>
        owner.recordId !== recordId ||
        owner.pageId !== pageId ||
        owner.role !== role,
    )
  )
    throw new ReviewedOutputError("unmanaged_collision");
  const previous = await readReviewedFile(
    path,
    true,
    REVIEWED_OUTPUT_LIMITS.imageBytes,
  );
  if (previous && !owners.length)
    throw new ReviewedOutputError("unmanaged_collision");
  return previous;
}

export async function planReviewedMirror(
  input: ReviewedNativeInput,
): Promise<ReviewedNativeFile> {
  const relativePath = buildLinkedMirrorFileName(input.rootPath);
  const path = resolvePathInside(input.rootPath, relativePath);
  await assertReviewedPath(input.rootPath, path);
  const mirror = await readReviewedJson(
    path,
    REVIEWED_OUTPUT_LIMITS.mirrorBytes,
  );
  if (mirror) assertOwnedMirror(mirror.value, input);
  return {
    fileId: "mirror:publish",
    role: "mirror",
    pageId: null,
    action: "publish",
    previous: mirror?.digest ?? null,
    relativePath,
    sourcePath: null,
    desired: null,
  };
}

function assertOwnedMirror(value: unknown, input: ReviewedNativeInput) {
  if (
    !value ||
    typeof value !== "object" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("chapters" in value) ||
    !Array.isArray(value.chapters)
  )
    throw new ReviewedOutputError("unmanaged_collision");
  const ids = value.chapters.map((chapter: unknown) => {
    if (
      !chapter ||
      typeof chapter !== "object" ||
      !("id" in chapter) ||
      !("workId" in chapter)
    )
      throw new ReviewedOutputError("unmanaged_collision");
    if (
      !input.records.some(
        (record) =>
          record.chapterId === chapter.id && record.workId === chapter.workId,
      )
    )
      throw new ReviewedOutputError("unmanaged_collision");
    return chapter.id;
  });
  if (ids.length !== input.records.length || new Set(ids).size !== ids.length)
    throw new ReviewedOutputError("unmanaged_collision");
}
