import {
  createPageRevision,
  createSoundEffectReviewPageRevision,
} from "../../shared/pageRevision";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  readChapterFile,
  findChapterLocation,
} from "../libraryStore/libraryFiles";
import { hydrateChapter } from "../libraryStore/chapterSnapshots";
import { mcpBatchMembership } from "../application/mcpPageBatchPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  RetainedChangeSchema,
  type RetainedChange,
} from "./mcpRetentionRecords";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import {
  captureRetainedPage,
  retainedPageFingerprint,
} from "./mcpRetentionEvidence";
import { retainedContextRevision } from "./mcpRetainedContext";

export async function readRetainedChange(
  storage: McpRetentionStorage,
  owner: string,
  id: string,
) {
  const { entry } = await storage.owned(owner, id, "change");
  const record = RetainedChangeSchema.parse(await storage.record(id));
  if (
    record.id !== id ||
    record.owner !== owner ||
    record.pages.length !== entry.pageCount ||
    new Set(
      record.pages.map((item) => `${item.chapterId}/${item.after.page.id}`),
    ).size !== record.pages.length
  )
    throw new McpEditError(
      "invalid_edit",
      "Retained change metadata is inconsistent.",
    );
  for (const item of record.pages)
    for (const state of [item.before, item.after])
      if (
        retainedPageFingerprint(state.page, state.files) !== state.fingerprint
      )
        throw new McpEditError(
          "invalid_edit",
          "Retained snapshot fingerprint is inconsistent.",
        );
  return { entry, record };
}
export async function inspectRecoveryPages(
  record: RetainedChange,
  guard: () => void,
) {
  const pages = [];
  for (const item of record.pages) {
    guard();
    const locator = await findChapterLocation(item.chapterId);
    const chapter =
      locator && locator.workId === item.workId
        ? await readChapterFile(item.workId, item.chapterId)
        : null;
    const page = chapter?.pages.find((page) => page.id === item.after.page.id);
    if (!chapter || !page)
      throw new McpEditError(
        "not_found",
        "A retained page no longer belongs to the saved work/chapter.",
      );
    if (mcpBatchMembership(hydrateChapter(chapter)) !== item.membership)
      throw new McpEditError(
        "revision_conflict",
        "Chapter membership or order changed since this history record.",
      );
    const current = await captureRetainedPage(page);
    const keys = [
      ...new Set([
        ...Object.keys(item.before.page),
        ...Object.keys(item.after.page),
      ]),
    ];
    const a: Record<string, unknown> = { ...item.before.page };
    const b: Record<string, unknown> = { ...item.after.page };
    pages.push({
      chapterId: item.chapterId,
      pageId: page.id,
      revision: createPageRevision(page),
      reviewRevision: createSoundEffectReviewPageRevision(page),
      matchesBefore: current.fingerprint === item.before.fingerprint,
      matchesAfter: current.fingerprint === item.after.fingerprint,
      contextMatches:
        (await retainedContextRevision(chapter.id)) === item.contextRevision,
      changedFields: keys.filter(
        (key) =>
          hashStableValue([Object.hasOwn(a, key), a[key]]) !==
          hashStableValue([Object.hasOwn(b, key), b[key]]),
      ),
      current,
    });
  }
  guard();
  return pages;
}
