import type { McpImportPageMapping } from "../../shared/mcpImportMapping";
import {
  importPublicationChapters,
  type McpImportPublication,
} from "../../shared/mcpImportPublication";
import type { McpWorkFileCreate } from "../../shared/mcpWorkFileImport";
import {
  prepareMcpImageImportMapping,
  prepareMcpWorkFileMapping,
  type McpPreparedImportMapping,
} from "../application/mcpImportMappingPolicy";

function matches(
  plan: McpPreparedImportMapping,
  mapping: McpImportPageMapping,
) {
  return (
    plan.review.selectionFingerprint === mapping.selectionFingerprint &&
    plan.items.length === mapping.items.length &&
    plan.items.every(
      (item, index) =>
        item.itemKey === mapping.items[index].itemKey &&
        item.chapterIndex === mapping.items[index].chapterIndex &&
        item.pageIndex === mapping.items[index].pageIndex,
    )
  );
}
/** Rechecks the sealed ordered selection without opening sources or inferring current pages. */
export function matchesImageImportMapping(
  input: McpImportPublication,
  mapping?: McpImportPageMapping,
) {
  if (!mapping) return true;
  if (mapping.sourceArchiveSha256) return false;
  const chapters = importPublicationChapters(input);
  if (
    chapters.some(
      (chapter, index) =>
        chapter.pageIds.length !== mapping.chapterPageCounts[index],
    )
  )
    return false;
  try {
    const identities = mapping.items.map((item) => ({
      draftId: chapters[item.chapterIndex].draftId,
      pageIndex: item.pageIndex,
      bytes: item.source.bytes,
      sha256: item.source.sha256,
    }));
    return matches(prepareMcpImageImportMapping(input, identities), mapping);
  } catch (error) {
    // Malformed retained evidence is an expected predicate failure. The record
    // schema reports its contextual validation issue; no native work runs here.
    void error;
    return false;
  }
}
export function matchesWorkFileImportMapping(
  input: McpWorkFileCreate,
  mapping?: McpImportPageMapping,
) {
  if (!mapping) return true;
  if (!mapping.sourceArchiveSha256) return false;
  try {
    const chapters = input.chapters.map((chapter, index) => ({
      packageChapterId: chapter.packageChapterId,
      // IDs are never inferred here. Opaque keys bind canonical indices plus exact archive SHA.
      pageIds: Array.from(
        { length: mapping.chapterPageCounts[index] },
        () => "",
      ),
    }));
    return matches(
      prepareMcpWorkFileMapping(input, mapping.sourceArchiveSha256, chapters),
      mapping,
    );
  } catch (error) {
    // Reconstructing invalid stored proof must reject the enclosing receipt.
    // Its record schema supplies the context without logging private evidence.
    void error;
    return false;
  }
}
