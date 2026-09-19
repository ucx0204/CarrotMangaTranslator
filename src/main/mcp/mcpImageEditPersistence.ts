import { unlink } from "node:fs/promises";
import type { MangaPage } from "../../shared/libraryTypes";
import type { PageRevision } from "../../shared/pageRevisionTypes";
import { createPageRevision } from "../../shared/pageRevision";
import { hashStableValue } from "../../shared/blockFingerprint";
import { updatePagesAfterInpainting } from "../library";
import type { InpaintingRevisionStore } from "../inpainting/inpaintingRevisionStore";
import { loadPageImage } from "../inpainting/imageIO";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpImageEditRequest } from "../application/mcpImageEditPolicy";
import type { McpImageProduct } from "./mcpImageEditExecution";
import {
  captureMcpImageFiles,
  verifyMcpImageFiles,
} from "./mcpImageEditEvidence";

// Internal publication consumes evidence and native recovery, not an engine command.
// The transport-facing planners still own strict command validation and authorization.
type ImagePublicationRequest = Omit<McpImageEditRequest, "change"> & {
  change: Pick<McpImageEditRequest["change"], "evidence" | "recovery" | "outcome">;
};

export type McpImageHistory = Pick<
  InpaintingRevisionStore,
  | "beginTransaction"
  | "addChange"
  | "discardIfEmpty"
  | "getRetainedArtifactPaths"
  | "releaseTransactions"
  | "inspectSinglePageTransaction"
  | "applySinglePageTransaction"
>;

export async function publishMcpImageEdit(options: {
  history: McpImageHistory;
  request: ImagePublicationRequest;
  before: MangaPage;
  product: McpImageProduct;
  mask: Uint8Array;
  guard: () => void;
  committed: (page: MangaPage) => void;
  remember: (id: string) => void;
}) {
  const {
    history,
    request,
    before,
    product,
    mask,
    guard,
    committed,
    remember,
  } = options;
  let transactionId: string | undefined;
  let saved = false;
  try {
    const changedPixels = await verifyPixelBoundary(before, product.page, mask);
    guard();
    recordOutcome(request, product, changedPixels);
    if (!changedPixels)
      throw new McpEditError(
        "invalid_edit",
        "The native operation changed no selected pixels. No page was saved and no automatic retry occurred.",
      );
    const files = await captureMcpImageFiles(product.page, guard);
    await verifyMcpImageFiles(request.change.evidence.files, guard);
    assertImageFieldsOnly(before, product.page);
    transactionId = recordImageHistory(history, request, before, product.page);
    guard();
    const chapter = await updatePagesAfterInpainting(
      request.chapterId,
      [product.page],
      {
        expectedTargets: [
          {
            chapterId: request.chapterId,
            pageId: request.pageId,
            revision: request.revision as PageRevision,
          },
        ],
        retainedInpaintedArtifactPaths: history.getRetainedArtifactPaths(
          request.chapterId,
        ),
      },
      guard,
    );
    saved = true;
    const page = chapter.pages.find((page) => page.id === request.pageId);
    if (!page)
      throw new Error("Saved image-edit page is missing; inspect the library.");
    request.change.recovery = {
      transactionId,
      files: [...request.change.evidence.files, ...files],
    };
    remember(transactionId);
    committed(page);
  } catch (error) {
    if (!saved && transactionId) {
      try {
        await history.releaseTransactions([transactionId]);
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "Image publication and history cleanup failed.",
          { cause: cleanup },
        );
      }
    } else if (!saved) {
      await discardMcpImageProduct(before, product.page, error);
    }
    throw error;
  }
}

export async function replayMcpImageEdit(
  history: McpImageHistory,
  request: ImagePublicationRequest,
  guard: () => void,
  committed: (revision: PageRevision) => Promise<void>,
) {
  const { transactionId, files } = request.change.recovery;
  if (!transactionId || !files)
    throw new McpEditError(
      "not_found",
      "Native session image history is unavailable.",
    );
  await verifyMcpImageFiles(files, guard);
  const view = await history.inspectSinglePageTransaction(
    transactionId,
    request,
  );
  if (
    view.revision !== request.revision ||
    view.state !== (request.direction === "undo" ? "applied" : "undone")
  )
    throw new McpEditError(
      "revision_conflict",
      `Image history is unavailable or changed (${view.reason}). Later edits are never overwritten.`,
    );
  const result = await history.applySinglePageTransaction(
    transactionId,
    request.direction === "undo" ? "undo" : "redo",
    {
      chapterId: request.chapterId,
      pageId: request.pageId,
      revision: request.revision as PageRevision,
      assertCanCommit: guard,
    },
  );
  await committed(result.revision);
}

export async function discardMcpImageProduct(
  before: MangaPage,
  next: MangaPage,
  error: unknown,
): Promise<never> {
  const retained = new Set([
    before.imagePath,
    before.inpaintedImagePath,
    before.inpaintMaskPath,
  ]);
  const paths = [
    ...new Set([next.inpaintedImagePath, next.inpaintMaskPath]),
  ].filter((path): path is string => Boolean(path) && !retained.has(path));
  const results = await Promise.allSettled(
    paths.map(async (path) => {
      try {
        await unlink(path);
      } catch (failure) {
        if (
          !(
            failure instanceof Error &&
            "code" in failure &&
            failure.code === "ENOENT"
          )
        )
          throw failure;
      }
    }),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length)
    throw new AggregateError(
      [error, ...failures],
      "Unpublished image cleanup failed.",
    );
  throw error;
}
function assertImageFieldsOnly(before: MangaPage, next: MangaPage) {
  const writable = new Set([
    "inpaintedImagePath",
    "inpaintMaskPath",
    "maskProvenance",
    "translationCompletion",
    "updatedAt",
  ]);
  const protectedFields = (page: MangaPage) =>
    Object.fromEntries(
      Object.entries(page).filter(([key]) => !writable.has(key)),
    );
  if (
    hashStableValue(protectedFields(before)) !==
    hashStableValue(protectedFields(next))
  )
    throw new McpEditError(
      "invalid_edit",
      "Image editing cannot modify blocks, geometry or unrelated page fields.",
    );
}
async function verifyPixelBoundary(
  before: MangaPage,
  next: MangaPage,
  mask: Uint8Array,
) {
  const original = await loadPageImage(
    before.inpaintedImagePath ?? before.imagePath,
  );
  const output = await loadPageImage(next.inpaintedImagePath ?? next.imagePath);
  const a = original.toBitmap(),
    b = output.toBitmap();
  if (a.length !== mask.length * 4 || b.length !== a.length)
    throw new McpEditError(
      "invalid_edit",
      "Image edit bitmap dimensions are inconsistent.",
    );
  let changed = 0;
  for (let i = 0; i < mask.length; i++) {
    const offset = i * 4;
    if (
      a[offset] === b[offset] &&
      a[offset + 1] === b[offset + 1] &&
      a[offset + 2] === b[offset + 2] &&
      a[offset + 3] === b[offset + 3]
    )
      continue;
    if (!mask[i])
      throw new McpEditError(
        "invalid_edit",
        "Native image processing changed a protected or unselected pixel. No page was saved.",
      );
    changed++;
  }
  return changed;
}

function recordImageHistory(
  history: McpImageHistory,
  request: ImagePublicationRequest,
  before: MangaPage,
  after: MangaPage,
) {
  const transactionId = history.beginTransaction();
  history.addChange(transactionId, {
    chapterId: request.chapterId,
    pageId: request.pageId,
    beforeRevision: createPageRevision(before),
    afterRevision: createPageRevision(after),
    beforePath: before.inpaintedImagePath,
    afterPath: after.inpaintedImagePath,
    beforeMaskPath: before.inpaintMaskPath,
    afterMaskPath: after.inpaintMaskPath,
    beforeMaskProvenance: before.maskProvenance,
    afterMaskProvenance: after.maskProvenance,
    beforeTranslationCompletion: before.translationCompletion,
    afterTranslationCompletion: after.translationCompletion,
  });
  return transactionId;
}

function recordOutcome(
  request: ImagePublicationRequest,
  product: McpImageProduct,
  changedPixels: number,
) {
  request.change.outcome = {
    changedPixels,
    componentsChanged: product.componentsChanged,
    componentsIncomplete: product.componentsIncomplete,
  };
}
