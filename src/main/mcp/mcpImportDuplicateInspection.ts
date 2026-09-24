import type { ImportChapterDraft } from "../../shared/importTypes";
import {
  ImportSourceIdentitySchema,
  matchImportSource,
  type ImportSourceIdentity,
} from "../../shared/importSourceIdentity";
import type { McpImportCreate } from "../../shared/mcpLibraryImport";
import { mcpImportDuplicateOutputs } from "../../shared/mcpImportDuplicates";
import { hashStableValue } from "../../shared/blockFingerprint";
import { McpEditError } from "../application/mcpEditPolicy";
import { readWorkFile, readChapterFile } from "../libraryStore/libraryFiles";

type History = { chapterId: string; source?: ImportSourceIdentity };

/** Caller owns the existing library read/mutation lock. No second history store. */
export async function inspectImportDuplicatesUnlocked(
  target: McpImportCreate["target"],
  chapters: ImportChapterDraft[],
  guard: () => void,
) {
  guard();
  const history = await readHistory(target, guard);
  const selected = chapters.map((chapter) => ({
    draftId: chapter.draftId,
    source: ImportSourceIdentitySchema.parse(chapter.importSource),
  }));
  const rows = selected.map((candidate) => {
    const matches = history.flatMap((previous) => {
      const match =
        previous.source && matchImportSource(candidate.source, previous.source);
      return match ? [{ chapterId: previous.chapterId, match }] : [];
    });
    const others = selected.filter(
      (other) => other.draftId !== candidate.draftId,
    );
    const inSelection = others.flatMap((other) => {
      const match = matchImportSource(candidate.source, other.source);
      return match ? [{ draftId: other.draftId, match }] : [];
    });
    const kinds = [...matches, ...inSelection].map((item) => item.match);
    return {
      draftId: candidate.draftId,
      status: kinds.some((kind) => kind !== "url")
        ? "known-content"
        : kinds.length
          ? "known-url"
          : "unseen",
      matchingChapterCount: matches.length,
      matches: matches.slice(0, 25),
      matchingDraftIds: inSelection.map((item) => item.draftId),
    };
  });
  guard();
  return mcpImportDuplicateOutputs.carrot_get_import_duplicates.parse({
    targetWorkId: target.mode === "existing" ? target.workId : null,
    historyChapterCount: history.filter((item) => item.source).length,
    untrackedChapterCount: history.filter((item) => !item.source).length,
    historicalOnly: true,
    chapters: rows,
    warnings: [
      "History describes previously imported selected input bytes, not current chapter integrity or whole-site completeness. No images or models are read from existing chapters.",
      "Unseen means no matching recorded history in this destination. Older or externally imported chapters without provenance remain untracked; titles are never used as proof.",
      "A known URL with different bytes can mean updated content, a different subset or a different page order. Review it rather than silently skipping or overwriting.",
      "Use duplicatePolicy=reject-known on selected ordinary or batch imports to recheck known content/URLs at publication. Omit known drafts/items explicitly; no implicit partial publication.",
    ],
  });
}
async function readHistory(
  target: McpImportCreate["target"],
  guard: () => void,
) {
  if (target.mode === "new") return [];
  const work = await readWorkFile(target.workId);
  if (!work)
    throw new McpEditError(
      "not_found",
      "Import destination work no longer exists.",
    );
  if (hashStableValue(work) !== target.snapshot)
    throw new McpEditError(
      "revision_conflict",
      "Read the current destination before duplicate review.",
    );
  if (work.chapterOrder.length > 2000)
    throw new McpEditError(
      "invalid_edit",
      "Duplicate inspection is bounded to two thousand destination chapters; no history was truncated.",
    );
  const history: History[] = [];
  for (const chapterId of work.chapterOrder) {
    guard();
    const chapter = await readChapterFile(work.id, chapterId);
    if (!chapter)
      throw new McpEditError(
        "revision_conflict",
        "A destination chapter is missing; duplicate history is incomplete.",
      );
    history.push({ chapterId, source: chapter.importSource });
  }
  return history;
}
