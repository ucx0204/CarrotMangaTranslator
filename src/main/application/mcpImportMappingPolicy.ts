import { createHash } from "node:crypto";
import {
  McpImportMappingReviewSchema,
  type McpImportMappingReview,
} from "../../shared/mcpImportMapping";
import {
  importPublicationSelections,
  type McpImportSelection,
} from "../../shared/mcpImportPublication";
import type { McpWorkFileCreate } from "../../shared/mcpWorkFileImport";
import { McpEditError } from "./mcpEditPolicy";

export type McpImportSourcePageIdentity = {
  draftId: string;
  pageIndex: number;
  bytes: number;
  sha256: string;
};
export type McpPreparedImportMapping = {
  kind: "image" | "work-file";
  review: McpImportMappingReview;
  sourceArchiveSha256?: string;
  items: {
    itemKey: string;
    chapterIndex: number;
    pageIndex: number;
    sourceChapterId: string;
    sourcePageId?: string;
    source?: { bytes: number; sha256: string };
  }[];
};
function digest(value: unknown) {
  const canonical = JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return entry;
    const object = entry as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, object[key]]),
    );
  });
  return createHash("sha256").update(canonical).digest("hex");
}
function finish(
  kind: McpPreparedImportMapping["kind"],
  binding: unknown,
  items: McpPreparedImportMapping["items"],
  maxChapters: number,
): McpPreparedImportMapping {
  const itemKeys = items.map((item) => item.itemKey);
  const review = McpImportMappingReviewSchema.parse({
    selectionFingerprint: digest([
      "mcp-import-selection-v1",
      kind,
      binding,
      itemKeys,
    ]),
    itemKeys,
    maxChapters,
    maxPages: items.length,
  });
  return { kind, review, items };
}

/** Every digest comes from the existing reserved-source identity pass. */
export function prepareMcpImageImportMapping(
  input: McpImportSelection,
  identities: readonly McpImportSourcePageIdentity[],
): McpPreparedImportMapping {
  // Pick types do not strip request replay fields from the runtime input.
  const selections = importPublicationSelections(input).map((selection) => ({
    previewId: selection.previewId,
    snapshot: selection.snapshot,
    chapters: selection.chapters,
    ...("itemId" in selection ? { itemId: selection.itemId } : {}),
  }));
  const items: McpPreparedImportMapping["items"] = [];
  let chapterIndex = 0;
  for (const selection of selections) {
    for (const chapter of selection.chapters) {
      const currentChapter = chapterIndex++;
      chapter.pageIds.forEach((pageId, pageIndex) => {
        const source = identities[items.length];
        if (
          !source ||
          source.draftId !== chapter.draftId ||
          source.pageIndex !== pageIndex
        )
          throw new McpEditError(
            "revision_conflict",
            "Reviewed source page identity is missing or out of order.",
          );
        if (
          !Number.isSafeInteger(source.bytes) ||
          source.bytes <= 0 ||
          !/^[a-f0-9]{64}$/.test(source.sha256)
        )
          throw new McpEditError(
            "revision_conflict",
            "Reviewed source page digest is invalid.",
          );
        items.push({
          itemKey: digest([
            "mcp-import-page-v1",
            "image",
            selection.previewId,
            selection.snapshot,
            chapter.draftId,
            pageId,
            source.bytes,
            source.sha256,
          ]),
          chapterIndex: currentChapter,
          pageIndex,
          sourceChapterId: chapter.draftId,
          source: { bytes: source.bytes, sha256: source.sha256 },
        });
      });
    }
  }
  if (identities.length !== items.length)
    throw new McpEditError(
      "revision_conflict",
      "Reviewed source identity contains unselected pages.",
    );
  return finish(
    "image",
    { target: input.target, selections },
    items,
    chapterIndex,
  );
}

/** The owned upload digest seals metadata and images; page order comes from native parsing. */
export function prepareMcpWorkFileMapping(
  input: McpWorkFileCreate,
  uploadSha256: string,
  chapters: readonly { packageChapterId: string; pageIds: readonly string[] }[],
): McpPreparedImportMapping {
  const items = input.chapters.flatMap((selected, chapterIndex) => {
    const chapter = chapters.find(
      (value) => value.packageChapterId === selected.packageChapterId,
    );
    if (!chapter)
      throw new McpEditError(
        "invalid_edit",
        "Selected package chapter has no verified page mapping.",
      );
    return chapter.pageIds.map((pageId, pageIndex) => ({
      itemKey: digest([
        "mcp-import-page-v1",
        "work-file",
        input.uploadId,
        input.snapshot,
        uploadSha256,
        selected.packageChapterId,
        pageIndex,
      ]),
      chapterIndex,
      pageIndex,
      sourceChapterId: selected.packageChapterId,
      sourcePageId: pageId,
    }));
  });
  return {
    ...finish(
      "work-file",
      {
        uploadId: input.uploadId,
        snapshot: input.snapshot,
        uploadSha256,
        target: input.target,
        chapters: input.chapters,
      },
      items,
      input.chapters.length,
    ),
    sourceArchiveSha256: uploadSha256,
  };
}
