import {
  prepareReviewedOutput,
  reviewedMirrorScope,
} from "./linkedWorkspaceReviewedOutputPlan";
import { readReviewedInput } from "./linkedWorkspaceReviewedOutputInput";
import { executeReviewedOutput } from "./linkedWorkspaceReviewedOutputExecute";
import { inspectReviewedOutputEvidence } from "./linkedWorkspaceReviewedOutputInspection";
import {
  ReviewedOutputError,
  type ReviewedLinkedOutputPort,
  type ReviewedOutputDestination,
  type ReviewedOutputSelection,
} from "./linkedWorkspaceReviewedOutputTypes";
import type { NativeLinkedOutputOwner } from "./linkedWorkspaceReviewedOutputInternal";
import type { LinkedWorkspaceRecordV1 } from "../../shared/linkedWorkspaceTypes";

/** The initialized native service is the only registry owner. No scheduler calls. */
export function createReviewedLinkedOutputPort(
  owner: NativeLinkedOutputOwner,
): ReviewedLinkedOutputPort {
  return {
    inspect: (chapterId, guard) => inspectDestination(owner, chapterId, guard),
    preflight: async (selection, guard) =>
      (await prepareSafe(owner, selection, guard)).review,
    execute: async (target, context) => {
      const guard = () => {
        context.signal.throwIfAborted();
        context.assertAuthorized();
      };
      const plan = await prepareSafe(owner, target, guard);
      if (target.selectionSnapshot !== plan.review.selectionSnapshot)
        throw new ReviewedOutputError("selection_changed");
      if (target.destinationSnapshot !== plan.review.destinationSnapshot)
        throw new ReviewedOutputError("destination_changed");
      if (target.sourceSnapshot !== plan.review.sourceSnapshot)
        throw new ReviewedOutputError("source_changed");
      return executeReviewedOutput(owner, plan, context);
    },
    inspectReceiptEvidence: (input, guard) =>
      inspectReviewedOutputEvidence(owner, input, guard),
  };
}

async function inspectDestination(
  owner: NativeLinkedOutputOwner,
  chapterId: string,
  guard: () => void,
): Promise<ReviewedOutputDestination> {
  guard();
  const record = owner.available()
    ? owner.records().find((record) => record.chapterId === chapterId)
    : undefined;
  const result = destinationMetadata(chapterId, record);
  if (!record) return result;
  try {
    const chapter = await owner.openChapter(chapterId);
    const input = await readReviewedInput(
      owner,
      {
        chapterId,
        connectionId: record.id,
        pageIds: chapter.pages.slice(0, 1).map((page) => page.id),
      },
      guard,
    );
    result.mirrorScope = reviewedMirrorScope(input);
    result.available = true;
    result.reason = null;
  } catch (error) {
    result.reason =
      error instanceof ReviewedOutputError
        ? error.code
        : "destination_unavailable";
  }
  guard();
  return result;
}

function destinationMetadata(
  chapterId: string,
  record?: LinkedWorkspaceRecordV1,
): ReviewedOutputDestination {
  return {
    chapterId,
    connectionId: record?.id ?? null,
    destinationKind: record?.destinationKind ?? null,
    enabled: record?.enabled ?? false,
    available: false,
    reason: "destination_unavailable",
    output: record?.output ?? null,
    mirrorScope: null,
  };
}

async function prepareSafe(
  owner: NativeLinkedOutputOwner,
  selection: ReviewedOutputSelection,
  guard: () => void,
) {
  try {
    return await prepareReviewedOutput(owner, selection, guard);
  } catch (error) {
    guard();
    if (error instanceof ReviewedOutputError) throw error;
    throw new ReviewedOutputError("source_changed", { cause: error });
  }
}
