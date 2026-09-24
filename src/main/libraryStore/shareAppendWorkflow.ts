import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { hashStableValue } from "../../shared/blockFingerprint";
import type {
  WorkShareImportFromPackageRequest,
  WorkShareImportResult,
} from "../../shared/shareTypes";
import { throwIfAborted } from "../abortSignal";
import { nextChapterUpdatedAt } from "./chapterRecords";
import { collectUsedChapterTitles, ensureExistingWork } from "./libraryFiles";
import { getWorksRoot } from "./libraryPaths";
import {
  runLibraryTransaction,
  type LibraryTransaction,
} from "./libraryTransaction";
import { stageWorkFile } from "./libraryTransactionFiles";
import { materializeSharedChapter } from "./shareImportMaterialize";
import {
  assertPackageOnlyEntries,
  type SharePackageSession,
} from "./sharePackage";
import { makeUniqueTitleInList, sanitizeTitle } from "./titles";
import { tMain } from "./localization";
import type { ImportImageRuntime } from "./importImageRuntime";
import type { ShareImportPublication } from "./shareImportPublication";
import {
  observeNativeImportedGuide,
  nativeImportedWorkObserver,
} from "./importPublicationMetadata";

/** Membership and title allocation only. Existing chapter files are never rewritten. */
export async function readShareAppendTarget(
  workId: string,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  const work = await ensureExistingWork(workId);
  if (work.chapterOrder.length > 2000)
    throw new Error("Share append destination exceeds 2,000 chapters.");
  const titles = [...(await collectUsedChapterTitles(workId))].sort();
  throwIfAborted(signal);
  return { work, titles, snapshot: hashStableValue([work, titles]) };
}

/** Uses the ordinary share reader/materializer; unlike replacement it has no retirement steps. */
export async function appendWorkShare(
  session: SharePackageSession,
  request: WorkShareImportFromPackageRequest,
  publication: ShareImportPublication,
  publish: Parameters<typeof runLibraryTransaction>[2],
  image: ImportImageRuntime | undefined,
  signal?: AbortSignal,
): Promise<WorkShareImportResult> {
  if (request.target.mode !== "append")
    throw new Error("Expected native append target.");
  assertPackageOnlyEntries(request.entries);
  const state = await readShareAppendTarget(request.target.workId, signal);
  if (
    !request.entries.length ||
    state.work.chapterOrder.length + request.entries.length > 2000
  )
    throw new Error(
      "Share append needs chapters within the destination capacity.",
    );
  const ids = request.entries.map((entry) => entry.packageChapterId);
  if (new Set(ids).size !== ids.length)
    throw new Error("Duplicate shared chapter selection.");
  publication.assertCanCommit();
  return runLibraryTransaction(
    "share-append-work",
    async (transaction) => {
      const titles = new Set(state.titles);
      const created = [];
      for (const entry of request.entries) {
        if (entry.source !== "package")
          throw new Error("Append cannot replace existing chapters.");
        created.push(
          await stageAppendChapter({
            transaction,
            session,
            entry,
            workId: state.work.id,
            titles,
            image,
            publication,
            signal,
          }),
        );
      }
      const result = {
        workId: state.work.id,
        chapterIds: created.map((chapter) => chapter.id),
      };
      registerAppendPublication(
        transaction,
        state,
        result,
        publication,
        signal,
      );
      return result;
    },
    publish,
    () => {
      throwIfAborted(signal);
      publication.assertCanCommit();
    },
  );
}

function registerAppendPublication(
  transaction: LibraryTransaction,
  state: Awaited<ReturnType<typeof readShareAppendTarget>>,
  result: WorkShareImportResult,
  publication: ShareImportPublication,
  signal?: AbortSignal,
) {
  transaction.beforePublish(async () => {
    const current = await readShareAppendTarget(state.work.id, signal);
    if (current.snapshot !== state.snapshot)
      throw new Error("Share append destination changed during preparation.");
    publication.assertCanCommit();
    await stageWorkFile(
      transaction,
      {
        ...current.work,
        chapterOrder: [...current.work.chapterOrder, ...result.chapterIds],
        updatedAt: nextChapterUpdatedAt({
          updatedAt: current.work.updatedAt,
          pages: [],
        }),
      },
      nativeImportedWorkObserver(
        state.work.id,
        publication.observeMetadata,
        signal,
      ),
    );
    if (publication.observeMetadata)
      await observeNativeImportedGuide({
        workId: state.work.id,
        directory: join(getWorksRoot(), state.work.id),
        observe: publication.observeMetadata,
        signal,
      });
    await publication.stage(transaction, result);
    throwIfAborted(signal);
  });
}

async function stageAppendChapter(options: {
  transaction: LibraryTransaction;
  session: SharePackageSession;
  entry: Extract<
    WorkShareImportFromPackageRequest["entries"][number],
    { source: "package" }
  >;
  workId: string;
  titles: Set<string>;
  image: ImportImageRuntime | undefined;
  publication: ShareImportPublication;
  signal?: AbortSignal;
}) {
  const { session, entry, signal, publication } = options;
  throwIfAborted(signal);
  publication.assertCanCommit();
  const source = await session.readChapter(entry.packageChapterId, signal);
  const chapter = publication.mapChapter
    ? publication.mapChapter(source)
    : source;
  const title = makeUniqueTitleInList(
    sanitizeTitle(entry.title || chapter.title, tMain("import.untitled")),
    options.titles,
  );
  options.titles.add(title);
  const chapterId = randomUUID();
  const directory = await options.transaction.createPublishedDirectory(
    join(getWorksRoot(), options.workId, "chapters", chapterId),
  );
  return materializeSharedChapter({
    workId: options.workId,
    chapterId,
    packageChapter: chapter,
    entries: session.entries,
    archiveReader: session.archiveReader,
    requestedTitle: title,
    imageRuntime: options.image,
    signal,
    writeChapterDirectory: directory.stagingDirectory,
    publishedChapterDirectory: directory.finalDirectory,
    observePage: publication.observePage,
    observeMetadata: publication.observeMetadata,
    sourceChapterId: entry.packageChapterId,
  });
}
