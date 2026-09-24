import { resolvePathInside } from "./linkedWorkspacePaths";
import {
  readReviewedInput,
  assertReviewedRecords,
} from "./linkedWorkspaceReviewedOutputInput";
import {
  readReviewedFile,
  assertReviewedDigest,
  assertReviewedPath,
  reviewedPathKey,
} from "./linkedWorkspaceReviewedOutputEvidence";
import { ReviewedOutputError } from "./linkedWorkspaceReviewedOutputTypes";
import type {
  NativeLinkedOutputOwner,
  ReviewedNativePlan,
  ReviewedNativeState,
} from "./linkedWorkspaceReviewedOutputInternal";

export async function verifyReviewedOutput(
  owner: NativeLinkedOutputOwner,
  plan: ReviewedNativePlan,
  state: ReviewedNativeState,
  guard: () => void,
  pageId: string | null = null,
  relativePath?: string,
) {
  guard();
  const fresh = await readReviewedInput(owner, plan.review, guard);
  if (fresh.selectionSnapshot !== plan.selectionSnapshot)
    throw new ReviewedOutputError("selection_changed");
  if (fresh.destinationSnapshot !== plan.destinationSnapshot)
    throw new ReviewedOutputError("destination_changed");
  assertReviewedRecords(state.records, fresh.records);
  await verifyReviewedSources(plan, pageId, guard);
  await verifyReviewedTargets(plan, state, relativePath, guard);
  guard();
}

async function verifyReviewedSources(
  plan: ReviewedNativePlan,
  pageId: string | null,
  guard: () => void,
) {
  for (const source of plan.sources) {
    if (pageId !== null && source.pageId !== pageId) continue;
    guard();
    assertReviewedDigest(
      await readReviewedFile(source.path, false, source.digest.bytes),
      source.digest,
    );
  }
}

async function verifyReviewedTargets(
  plan: ReviewedNativePlan,
  state: ReviewedNativeState,
  relativePath: string | undefined,
  guard: () => void,
) {
  const target = relativePath
    ? reviewedPathKey(resolvePathInside(plan.rootPath, relativePath))
    : null;
  for (const [path, expected] of state.targets) {
    if (target && path !== target) continue;
    guard();
    await assertReviewedPath(plan.rootPath, path);
    assertReviewedDigest(
      await readReviewedFile(path, true, expected?.bytes ?? 0),
      expected,
    );
  }
}
