import { mcpContextRevision } from "../../shared/mcpContextEditing";
import { createPageRevision } from "../../shared/pageRevision";
import type { McpCompositeCost } from "../application/mcpCompositeWorkflowPorts";
import { zeroCompositeCost } from "../application/mcpCompositeWorkflowPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpCompositeNativePage } from "./mcpCompositeNativePages";

export function nativeCompositeCost(pageAttempts = 0): McpCompositeCost {
  return { ...zeroCompositeCost(), admissions: 1, pageAttempts };
}
export function selectCompositeNativePages(
  values: McpCompositeNativePage[],
  chapterId: string,
  pages: Array<{ pageId: string; revision?: string; blockIds?: string[] }>,
  contextRevision?: string,
) {
  if (
    !pages.length ||
    pages.length > 50 ||
    new Set(pages.map((page) => page.pageId)).size !== pages.length
  )
    throw scopeError();
  return pages.map((requested) => {
    const value = values.find(
      ({ target }) =>
        target.chapterId === chapterId && target.pageId === requested.pageId,
    );
    if (
      !value ||
      (requested.revision &&
        createPageRevision(value.page) !== requested.revision) ||
      (contextRevision && mcpContextRevision(value.saved) !== contextRevision)
    )
      throw scopeError();
    if (requested.blockIds) assertCompositeBlocks(value, requested.blockIds);
    return value;
  });
}
export function assertCompositeBlocks(
  value: McpCompositeNativePage,
  ids: string[],
  allowCreated = false,
) {
  if (ids.length > 100 || new Set(ids).size !== ids.length) throw scopeError();
  if (value.target.blockIds.length) {
    if (ids.some((id) => !value.target.blockIds.includes(id)))
      throw scopeError();
  } else if (allowCreated) return;
  if (ids.some((id) => !value.page.blocks.some((block) => block.id === id)))
    throw scopeError();
}
export function requireCompositeWholePages(values: McpCompositeNativePage[]) {
  if (values.some(({ target }) => target.blockIds.length))
    throw new McpEditError(
      "invalid_edit",
      "This native action changes whole saved pages; prepare an explicit whole-page scope before using it.",
    );
}
export function scopeError() {
  return new McpEditError(
    "revision_conflict",
    "Native targets or their revisions exceed the fixed composite page/block/context selection.",
  );
}
