import type {
  CreateImportFromPreviewRequest,
  ImportPreviewResult,
} from "../../shared/importTypes";
import {
  importPublicationSelections,
  type McpImportSelection,
} from "../../shared/mcpImportPublication";
import { McpEditError } from "./mcpEditPolicy";

type Entry = {
  prepared: { preview: ImportPreviewResult };
  pageIds: string[][];
};
/** Selection changes only copied drafts; reviewed source bytes and original names are immutable. */
export function selectMcpImport(
  entries: Entry[],
  input: McpImportSelection,
): CreateImportFromPreviewRequest {
  const selections = importPublicationSelections(input);
  const chapters = selections.flatMap((selection, index) =>
    selectChapters(entries[index], selection.chapters),
  );
  return {
    preview: {
      ...entries[0].prepared.preview,
      mode: entries.length > 1 ? "batch" : entries[0].prepared.preview.mode,
      chapters,
    },
    target:
      input.target.mode === "new"
        ? { mode: "new", title: input.target.title }
        : { mode: "existing", workId: input.target.workId },
    selections: chapters.map((chapter) => ({
      draftId: chapter.draftId,
      title: chapter.title,
      enabled: true,
    })),
  };
}
function selectChapters(
  entry: Entry,
  selections: ReturnType<
    typeof importPublicationSelections
  >[number]["chapters"],
) {
  return selections.map((selection) => {
    const index = entry.prepared.preview.chapters.findIndex(
      (chapter) => chapter.draftId === selection.draftId,
    );
    const chapter = entry.prepared.preview.chapters[index];
    if (!chapter)
      throw new McpEditError(
        "invalid_edit",
        "A selected draft is not in this owned preview.",
      );
    const pages = selection.pageIds.map((id, position) => {
      const page = chapter.pages[entry.pageIds[index].indexOf(id)];
      if (!page)
        throw new McpEditError(
          "invalid_edit",
          "A selected page is not in its reviewed chapter.",
        );
      const selected = structuredClone(page);
      // Native web-import storage numbers are contiguous in the selected final order.
      if (selected.storageStem !== undefined)
        selected.storageStem = String(position + 1);
      return selected;
    });
    return { ...chapter, title: selection.title, pages };
  });
}
