import {
  createPageRevision,
  createSoundEffectReviewPageRevision,
} from "../../shared/pageRevision";
import type { McpImportPageMapping } from "../../shared/mcpImportMapping";
import type {
  McpCompositeGuard,
  McpCompositeOutcome,
  McpCompositeRecord,
  McpCompositeSavedBinding,
} from "../application/mcpCompositeWorkflowPorts";
import { compositeFingerprint } from "../application/mcpCompositeWorkflowPolicy";
import {
  fingerprintNativeImportFiles,
  type NativeImportFileDigest,
} from "../libraryStore/importPublicationEvidence";
import { verifyNativeImportPublicationMetadata } from "../libraryStore/importPublicationMetadata";
import type { McpCompositeNativeCalls } from "./mcpCompositeNativeCalls";
import {
  compositeNativeRequirements,
  type CompositeNativeOptions,
  type CompositeSourceRead,
} from "./mcpCompositeNativeResolve";
import { readMcpCompositeSources } from "./mcpCompositeNativePages";
import { readCompositeImportMapping } from "./mcpCompositeNativeResults";
import { scopeError } from "./mcpCompositeNativeScope";

/** Admit saved targets only from the native publication mapping and its exact saved bytes. */
export async function verifyCompositeImportedPages(
  options: CompositeNativeOptions,
  calls: McpCompositeNativeCalls,
  record: McpCompositeRecord,
  binding: McpCompositeSavedBinding,
  outcome: McpCompositeOutcome,
  current: CompositeSourceRead,
  guard: McpCompositeGuard,
) {
  const job = await calls.findJob(binding);
  if (!job || job.jobId !== outcome.receipt.id || binding.snapshot.pages.length)
    throw scopeError();
  const mapping = await readCompositeImportMapping(
    options,
    binding,
    job,
    guard,
  );
  const envelope = record.plan.targets;
  if (
    envelope.kind !== "reviewed-import" ||
    envelope.selectionFingerprint !== mapping.selectionFingerprint ||
    compositeFingerprint(envelope.itemKeys) !==
      compositeFingerprint(mapping.items.map((item) => item.itemKey)) ||
    mapping.chapterPageCounts.length !== envelope.maxChapters ||
    mapping.items.length !== current.values.length
  )
    throw scopeError();
  if (!mapping.publication) throw scopeError();
  await verifyNativeImportPublicationMetadata(mapping.publication, guard);
  verifyImportedInventory(current, mapping);
  for (const [index, item] of mapping.items.entries())
    verifyImportedPage(current.values[index], item);
  const reread = await readMcpCompositeSources(
    record.targets,
    record.plan,
    guard,
    {
      ...options,
      requirements: (plan) => compositeNativeRequirements(options, plan),
    },
  );
  if (reread.snapshot.fingerprint !== current.snapshot.fingerprint)
    throw scopeError();
  await verifyNativeImportPublicationMetadata(mapping.publication, guard);
  guard();
}
function verifyImportedInventory(
  current: CompositeSourceRead,
  mapping: McpImportPageMapping,
) {
  for (const value of current.values) {
    const expected = mapping.items
      .filter((item) => item.page.chapterId === value.target.chapterId)
      .map((item) => item.page.pageId);
    if (
      compositeFingerprint(value.saved.chapter.pages.map((page) => page.id)) !==
      compositeFingerprint(expected)
    )
      throw scopeError();
  }
}
function verifyImportedPage(
  value: CompositeSourceRead["values"][number],
  item: McpImportPageMapping["items"][number],
) {
  const target = value.target;
  if (
    target.workId !== item.page.workId ||
    target.chapterId !== item.page.chapterId ||
    target.pageId !== item.page.pageId ||
    target.blockIds.length ||
    createPageRevision(value.page) !== item.page.revision ||
    createSoundEffectReviewPageRevision(value.page) !==
      item.page.reviewRevision ||
    value.saved.chapter.pages[item.pageIndex]?.id !== item.page.pageId
  )
    throw scopeError();
  if (
    value.page.blocks.length !== item.page.blockCount ||
    compositeFingerprint(value.page.blocks.map((block) => block.id)) !==
      item.page.blockIdsSha256 ||
    fingerprintNativeImportFiles(importedFiles(value)) !== item.page.filesSha256
  )
    throw scopeError();
  verifyImportedOriginal(value, item);
}
function verifyImportedOriginal(
  value: CompositeSourceRead["values"][number],
  item: McpImportPageMapping["items"][number],
) {
  const original = value.state.files.find(
    (file) => file.path === value.page.imagePath,
  );
  if (
    original?.bytes !== item.original.bytes ||
    original.sha256 !== item.original.sha256
  )
    throw scopeError();
}
function importedFiles(
  value: CompositeSourceRead["values"][number],
): NativeImportFileDigest[] {
  const roles = [
    ["original", value.page.imagePath],
    ["inpainted", value.page.inpaintedImagePath],
    ["mask", value.page.inpaintMaskPath],
  ] as const;
  return roles.flatMap(([role, path]) => {
    if (!path) return [];
    const file = value.state.files.find((item) => item.path === path);
    if (!file) throw scopeError();
    return [{ role, bytes: file.bytes, sha256: file.sha256 }];
  });
}
