import { join } from "node:path";
import {
  buildLinkedMirrorFileName,
  normalizeLinkedRelativePath,
  resolvePathInside,
} from "./linkedWorkspacePaths";
import { readReviewedInput } from "./linkedWorkspaceReviewedOutputInput";
import {
  assertReviewedPath,
  readReviewedFile,
  reviewedPathKey,
  sameReviewedDigest,
} from "./linkedWorkspaceReviewedOutputEvidence";
import {
  REVIEWED_OUTPUT_LIMITS,
  ReviewedOutputError,
  type ReviewedOutputDigest,
  type ReviewedOutputEvidence,
  type ReviewedOutputEvidenceInput,
  type ReviewedOutputIntent,
} from "./linkedWorkspaceReviewedOutputTypes";
import type { NativeLinkedOutputOwner } from "./linkedWorkspaceReviewedOutputInternal";

/** Compare current bytes only. A match never proves which execution wrote them. */
export async function inspectReviewedOutputEvidence(
  owner: NativeLinkedOutputOwner,
  request: ReviewedOutputEvidenceInput,
  guard: () => void,
): Promise<ReviewedOutputEvidence> {
  guard();
  validateRequest(request);
  const result: ReviewedOutputEvidence = {
    extent: "current-destination-files-only",
    sourceChecked: false,
    destination: "unavailable",
    checkedAt: Date.now(),
    files: request.targets.map(({ fileId }) => ({
      fileId,
      currentState: "unavailable",
      bytes: null,
      sha256: null,
    })),
  };
  const input = await currentDestination(owner, request, guard);
  if (!input) return result;
  result.files = await inspectTargets(
    owner,
    input.rootPath,
    request.targets,
    guard,
  );
  guard();
  if (await currentDestination(owner, request, guard))
    result.destination = "matched";
  else
    for (const output of result.files)
      Object.assign(output, {
        currentState: "unavailable",
        bytes: null,
        sha256: null,
      });
  result.checkedAt = Date.now();
  return result;
}

type EvidenceReadState = {
  cache: Map<string, ReviewedOutputDigest | null>;
  remainingBytes: number;
};

async function inspectTargets(
  owner: NativeLinkedOutputOwner,
  rootPath: string,
  targets: ReviewedOutputIntent[],
  guard: () => void,
) {
  const readState: EvidenceReadState = {
    cache: new Map(),
    remainingBytes: REVIEWED_OUTPUT_LIMITS.publishedBytes,
  };
  const files: ReviewedOutputEvidence["files"] = [];
  for (const target of targets) {
    guard();
    const output: ReviewedOutputEvidence["files"][number] = {
      fileId: target.fileId,
      currentState: "unavailable",
      bytes: null,
      sha256: null,
    };
    files.push(output);
    try {
      const actual = await readTargetEvidence(
        owner.dataRoot,
        rootPath,
        target,
        readState,
      );
      if (actual === "not_checked") output.currentState = "not_checked";
      else Object.assign(output, compareEvidence(target, actual));
    } catch (_error) {
      guard();
      output.currentState = "unavailable";
    }
  }
  return files;
}

async function readTargetEvidence(
  dataRoot: string,
  rootPath: string,
  target: ReviewedOutputIntent,
  state: EvidenceReadState,
) {
  const path = evidencePath(dataRoot, rootPath, target);
  const key = reviewedPathKey(path);
  if (state.cache.has(key)) return state.cache.get(key) ?? null;
  if (state.remainingBytes === 0) return "not_checked";
  await assertReviewedPath(
    target.role === "registry" ? dataRoot : rootPath,
    path,
  );
  const reservedBytes = Math.min(state.remainingBytes, evidenceLimit(target));
  state.remainingBytes -= reservedBytes;
  const digest = await readReviewedFile(path, true, reservedBytes);
  state.cache.set(key, digest);
  state.remainingBytes += reservedBytes - (digest?.bytes ?? 0);
  return digest;
}

async function currentDestination(
  owner: NativeLinkedOutputOwner,
  request: ReviewedOutputEvidenceInput,
  guard: () => void,
) {
  try {
    const input = await readReviewedInput(owner, request.selection, guard);
    return input.destinationSnapshot === request.destinationSnapshot
      ? input
      : null;
  } catch (_error) {
    guard();
    return null;
  }
}

function validateRequest(request: ReviewedOutputEvidenceInput) {
  if (
    request.targets.length > REVIEWED_OUTPUT_LIMITS.receiptFiles ||
    new Set(request.targets.map(({ fileId }) => fileId)).size !==
      request.targets.length ||
    !/^[0-9a-f]{16}$/.test(request.destinationSnapshot)
  )
    throw new ReviewedOutputError("limit_exceeded");
  for (const target of request.targets) {
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(target.fileId))
      throw new ReviewedOutputError("unsafe_path");
    validateDigest(target.previous, target);
    validateDigest(target.desired, target);
    if (
      target.action === "publish"
        ? !target.desired
        : target.action !== "remove" || target.desired !== null
    )
      throw new ReviewedOutputError("unsafe_path");
    validateTargetIdentity(request, target);
  }
}

function validateTargetIdentity(
  request: ReviewedOutputEvidenceInput,
  target: ReviewedOutputIntent,
) {
  if (target.role === "registry") {
    validateRegistryIdentity(request, target);
    return;
  }
  if (target.role === "mirror") {
    if (
      target.fileId !== "mirror:publish" ||
      target.pageId !== null ||
      target.action !== "publish"
    )
      throw new ReviewedOutputError("unsafe_path");
  } else if (
    !target.pageId ||
    !request.selection.pageIds.includes(target.pageId) ||
    !["result", "inpainted", "mask"].includes(target.role) ||
    target.fileId !== target.role + ":" + target.pageId + ":" + target.action
  ) {
    throw new ReviewedOutputError("unsafe_path");
  }
  validateRelativePath(target);
}

function validateRegistryIdentity(
  request: ReviewedOutputEvidenceInput,
  target: ReviewedOutputIntent,
) {
  const index = /^registry:(\d{1,2}):publish$/.exec(target.fileId)?.[1];
  if (
    index === undefined ||
    String(Number(index)) !== index ||
    Number(index) > request.selection.pageIds.length ||
    target.relativePath !== null ||
    target.pageId !== null ||
    target.action !== "publish"
  )
    throw new ReviewedOutputError("unsafe_path");
}

function validateRelativePath(target: ReviewedOutputIntent) {
  const value = target.relativePath;
  if (
    !value ||
    value.length > 4096 ||
    normalizeLinkedRelativePath(value) !== value ||
    /[\\:\x00]/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new ReviewedOutputError("unsafe_path");
  if (target.role !== "mirror" && !value.startsWith(target.role + "/"))
    throw new ReviewedOutputError("unsafe_path");
}

function validateDigest(
  digest: ReviewedOutputDigest | null,
  target: ReviewedOutputIntent,
) {
  if (
    digest &&
    (!Number.isSafeInteger(digest.bytes) ||
      digest.bytes < 0 ||
      digest.bytes > evidenceLimit(target) ||
      !/^[0-9a-f]{64}$/.test(digest.sha256))
  )
    throw new ReviewedOutputError("limit_exceeded");
}

function evidenceLimit(target: ReviewedOutputIntent) {
  return target.role === "mirror" || target.role === "registry"
    ? REVIEWED_OUTPUT_LIMITS.mirrorBytes
    : REVIEWED_OUTPUT_LIMITS.imageBytes;
}

function evidencePath(
  dataRoot: string,
  rootPath: string,
  target: ReviewedOutputIntent,
) {
  if (target.role === "registry")
    return join(dataRoot, "linked-workspaces.json");
  if (!target.relativePath) throw new ReviewedOutputError("unsafe_path");
  if (
    target.role === "mirror" &&
    target.relativePath !== buildLinkedMirrorFileName(rootPath)
  )
    throw new ReviewedOutputError("unsafe_path");
  return resolvePathInside(rootPath, target.relativePath);
}

function compareEvidence(
  target: ReviewedOutputIntent,
  actual: ReviewedOutputDigest | null,
) {
  const currentState =
    actual === null
      ? "missing"
      : sameReviewedDigest(actual, target.desired)
        ? "matches_planned"
        : sameReviewedDigest(actual, target.previous)
          ? "matches_previous"
          : "changed";
  return {
    currentState,
    bytes: actual?.bytes ?? null,
    sha256: actual?.sha256 ?? null,
  };
}
