import { hashStableValue } from "../../shared/blockFingerprint";
import {
  collectUsedChapterTitles,
  getDefaultWorkTitle,
  makeUniqueChapterTitle,
  readChapterFile,
  readWorkFile,
  type ChapterFile,
  type WorkFile,
} from "./libraryFiles";
import { nextChapterUpdatedAt, reorderIds } from "./chapterRecords";
import { sanitizeTitle } from "./titles";
import {
  runLibraryTransaction,
  type LibraryTransaction,
} from "./libraryTransaction";
import { stageChapterFile, stageWorkFile } from "./libraryTransactionFiles";
import {
  readLibraryPageOrdering,
  prepareLibraryPageOrdering,
  restoreLibraryPageOrdering,
  stageLibraryPageOrdering,
  type LibraryPageOrdering,
} from "./libraryPageOrdering";

type Target = { workId: string; chapterId?: string; kind?: string };
type Intent =
  | { kind: "rename-work"; workId: string; title: string }
  | { kind: "rename-chapter"; workId: string; chapterId: string; title: string }
  | { kind: "reorder-chapters"; workId: string; chapterIds: string[] }
  | {
      kind: "reorder-pages";
      workId: string;
      chapterId: string;
      pageIds: string[];
    };
type State = {
  work: WorkFile;
  chapter: ChapterFile | null;
  siblingTitles: string[];
  pageOrdering?: LibraryPageOrdering;
};
type Fields = {
  work: Pick<WorkFile, "title" | "chapterOrder" | "updatedAt">;
  chapter: Pick<ChapterFile, "title" | "updatedAt"> | null;
  pageOrdering?: LibraryPageOrdering;
};

/** Native metadata only. Caller holds the existing library read/write lock. */
export async function readLibraryOrganizationUnlocked(
  target: Target,
): Promise<State> {
  const work = await readWorkFile(target.workId);
  if (!work) throw new Error("작품을 찾지 못했습니다.");
  if (!target.chapterId) return { work, chapter: null, siblingTitles: [] };
  if (!work.chapterOrder.includes(target.chapterId))
    throw new Error("화 소속이 변경됐습니다.");
  const chapter = await readChapterFile(work.id, target.chapterId);
  if (!chapter) throw new Error("화를 찾지 못했습니다.");
  if (target.kind === "reorder-pages")
    return {
      work,
      chapter,
      siblingTitles: [],
      pageOrdering: await readLibraryPageOrdering(chapter),
    };
  const titles = await collectUsedChapterTitles(work.id, chapter.id);
  return { work, chapter, siblingTitles: [...titles].sort() };
}

/** The original title and partial-order policies are shared by desktop and MCP. */
export async function prepareLibraryOrganizationUnlocked(intent: Intent) {
  const before = await readLibraryOrganizationUnlocked(intent);
  const after = structuredClone(before);
  if (intent.kind === "rename-work") {
    after.work.title = sanitizeTitle(intent.title, getDefaultWorkTitle());
    after.work.updatedAt = new Date().toISOString();
  } else if (intent.kind === "reorder-chapters") {
    after.work.chapterOrder = reorderIds(
      before.work.chapterOrder,
      intent.chapterIds,
    );
    after.work.updatedAt = new Date().toISOString();
  } else {
    if (!after.chapter) throw new Error("Missing prepared chapter.");
    const updatedAt = nextChapterUpdatedAt(after.chapter);
    if (intent.kind === "reorder-pages") {
      if (!after.pageOrdering) throw new Error("Missing prepared page order.");
      const prepared = prepareLibraryPageOrdering(
        after.chapter,
        after.pageOrdering,
        intent.pageIds,
        updatedAt,
      );
      after.chapter = prepared.chapter;
      after.pageOrdering = prepared.ordering;
    } else {
      after.chapter.title = await makeUniqueChapterTitle(
        intent.workId,
        sanitizeTitle(intent.title, "제목없음"),
        intent.chapterId,
      );
      after.chapter.updatedAt = updatedAt;
    }
    after.work.updatedAt = updatedAt;
  }
  return { before, after };
}

export function libraryOrganizationSnapshot(state: State): string {
  return hashStableValue(state);
}

/** Page-order recovery also retains the supported memory fields that reconciliation changes. */
export function libraryOrganizationFields(state: State): Fields {
  return {
    work: {
      title: state.work.title,
      chapterOrder: [...state.work.chapterOrder],
      updatedAt: state.work.updatedAt,
    },
    chapter: state.chapter
      ? { title: state.chapter.title, updatedAt: state.chapter.updatedAt }
      : null,
    ...(state.pageOrdering
      ? { pageOrdering: structuredClone(state.pageOrdering) }
      : {}),
  };
}

/** Trusted native recovery only, never a serialized public edit request. */
export function restoreLibraryOrganizationFields(
  current: State,
  fields: Fields,
): State {
  if (
    Boolean(current.chapter) !== Boolean(fields.chapter) ||
    Boolean(current.pageOrdering) !== Boolean(fields.pageOrdering)
  )
    throw new Error("Recovery target shape differs.");
  const chapter =
    current.chapter && fields.chapter
      ? { ...current.chapter, ...fields.chapter }
      : null;
  return {
    ...current,
    work: {
      ...current.work,
      ...fields.work,
      chapterOrder: [...fields.work.chapterOrder],
    },
    chapter:
      chapter && fields.pageOrdering
        ? restoreLibraryPageOrdering(chapter, fields.pageOrdering)
        : chapter,
    ...(fields.pageOrdering
      ? { pageOrdering: structuredClone(fields.pageOrdering) }
      : {}),
  };
}

/** The optional receipt joins the same native publication, never a later write. */
export async function commitLibraryOrganizationUnlocked(
  change: { before: State; after: State },
  publication?: {
    guard: () => void;
    stage: (transaction: LibraryTransaction) => Promise<void>;
  },
) {
  const { before, after } = change;
  const target = {
    workId: before.work.id,
    ...(before.chapter ? { chapterId: before.chapter.id } : {}),
    ...(before.pageOrdering ? { kind: "reorder-pages" } : {}),
  };
  const expected = libraryOrganizationSnapshot(before);
  const verify = async () => {
    publication?.guard();
    const current = await readLibraryOrganizationUnlocked(target);
    if (libraryOrganizationSnapshot(current) !== expected)
      throw new Error("Library organization changed before publication.");
    publication?.guard();
  };
  await runLibraryTransaction(
    "library-organization",
    async (transaction) => {
      await verify();
      if (hashStableValue(before.work) !== hashStableValue(after.work))
        await stageWorkFile(transaction, after.work);
      if (
        after.chapter &&
        hashStableValue(before.chapter) !== hashStableValue(after.chapter)
      )
        await stageChapterFile(transaction, after.chapter);
      if (before.pageOrdering && after.pageOrdering)
        await stageLibraryPageOrdering(
          transaction,
          before.pageOrdering,
          after.pageOrdering,
        );
      await publication?.stage(transaction);
      transaction.beforePublish(verify);
    },
    undefined,
    publication?.guard,
  );
}
