import type { McpContextSnapshot } from "../application/mcpContextEditPolicy";
import {
  assertMcpSelectionFreshness,
  type McpSelectionBinding,
} from "../application/mcpSelectionAnalysisService";
import { mcpBatchMembership } from "../application/mcpPageBatchPolicy";
import type { McpSelectionInput } from "../../shared/mcpSelectionAnalysis";
import { hashMcpOriginalImage } from "./mcpTypographySourceEvidence";
import { readWorkContextForEdit } from "../library";
import { McpEditError } from "../application/mcpEditPolicy";

export async function captureMcpSelectionEvidence(
  saved: McpContextSnapshot,
  input: McpSelectionInput,
  guard: () => void,
): Promise<McpSelectionBinding> {
  const binding: McpSelectionBinding = {
    chapterId: input.chapterId,
    contextRevision: input.contextRevision,
    membership: mcpBatchMembership(saved.chapter),
    pages: input.pages.map(({ pageId, revision }) => ({ pageId, revision })),
  };
  assertMcpSelectionFreshness(saved, binding);
  if (!("expectedEngine" in input)) {
    for (const target of binding.pages) {
      guard();
      const page = saved.chapter.pages.find(
        (page) => page.id === target.pageId,
      );
      if (!page)
        throw new McpEditError("not_found", "Selected page is missing.");
      target.sourceHash = await hashMcpOriginalImage(page.imagePath, guard);
    }
  }
  guard();
  return binding;
}

export async function verifyMcpSelectionEvidence(
  binding: McpSelectionBinding,
  guard: () => void,
): Promise<void> {
  guard();
  const saved = await readWorkContextForEdit(binding.chapterId);
  guard();
  assertMcpSelectionFreshness(saved, binding);
  for (const target of binding.pages) {
    if (!target.sourceHash) continue;
    const page = saved.chapter.pages.find((page) => page.id === target.pageId);
    if (
      !page ||
      (await hashMcpOriginalImage(page.imagePath, guard)) !== target.sourceHash
    )
      throw new McpEditError(
        "revision_conflict",
        "Selected original image changed. Prepare new evidence before applying.",
      );
  }
  guard();
}
