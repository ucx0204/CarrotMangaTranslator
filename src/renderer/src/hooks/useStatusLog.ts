import React from "react";
import { appGateway as mangaGateway } from "../api/appGateway";
import type {
  ChapterSnapshot,
  LibraryIndex,
} from "../../../shared/libraryTypes";

export type StatusLogContext = {
  chapterId: string;
  chapterTitle: string;
  workTitle?: string;
};

export type StatusLogEntry = {
  message: string;
  context?: StatusLogContext;
};

export type AppendStatusLine = (
  line: string,
  replaceExisting?: (line: string) => boolean,
  chapterId?: string,
) => void;

type UseStatusLogResult = {
  statusEntries: StatusLogEntry[];
  statusLines: string[];
  appendStatusLine: AppendStatusLine;
  pushStatus: (line: string, chapterId?: string) => void;
  clearStatusLines: () => void;
};

type UseStatusLogOptions = {
  currentChapter?: ChapterSnapshot | null;
  library?: LibraryIndex;
};

export function useStatusLog(
  options: UseStatusLogOptions = {},
): UseStatusLogResult {
  const contextSourceRef = React.useRef(options);
  React.useEffect(() => {
    contextSourceRef.current = options;
  }, [options]);
  const [statusEntries, setStatusEntries] = React.useState<StatusLogEntry[]>(
    [],
  );
  const statusLines = React.useMemo(
    () => statusEntries.map((entry) => entry.message),
    [statusEntries],
  );

  /*
   * Lines already written stay as they are after a language switch. They are a
   * record of what happened, and re-translating them is impossible once the
   * arguments are gone — dropping the history to keep the panel monolingual
   * would throw away the only account of a failure the user is investigating.
   */

  const appendStatusLine = React.useCallback(
    (
      line: string,
      replaceExisting?: (line: string) => boolean,
      chapterId?: string,
    ) => {
      const next = line.trim();
      if (!next) {
        return;
      }
      const context = resolveStatusLogContext(
        contextSourceRef.current,
        chapterId,
      );
      setStatusEntries((entries) => {
        if (
          entries[0]?.message === next &&
          sameStatusLogScope(entries[0]?.context, context)
        ) {
          return entries;
        }
        const remaining = replaceExisting
          ? entries.filter(
              (entry) =>
                !sameStatusLogScope(entry.context, context) ||
                !replaceExisting(entry.message),
            )
          : entries;
        return [
          { message: next, ...(context ? { context } : {}) },
          ...remaining,
        ];
      });
    },
    [],
  );

  const pushStatus = React.useCallback(
    (line: string, chapterId?: string) => {
      void mangaGateway
        .writeLog("info", "UI status", { line })
        .catch((error) => console.warn(error));
      appendStatusLine(line, undefined, chapterId);
    },
    [appendStatusLine],
  );

  const clearStatusLines = React.useCallback(() => {
    setStatusEntries([]);
  }, []);

  return {
    statusEntries,
    statusLines,
    appendStatusLine,
    pushStatus,
    clearStatusLines,
  };
}

function resolveStatusLogContext(
  { currentChapter, library }: UseStatusLogOptions,
  requestedChapterId?: string,
): StatusLogContext | undefined {
  const chapterId = requestedChapterId ?? currentChapter?.id;
  if (!chapterId) return undefined;
  const work = findStatusLogWork(library, currentChapter, chapterId);
  const summary = work?.chapters.find((chapter) => chapter.id === chapterId);
  const currentTitle = getCurrentChapterTitle(currentChapter, chapterId);
  const chapterTitle = summary?.title ?? currentTitle;
  if (!chapterTitle) return undefined;
  return {
    chapterId,
    chapterTitle,
    ...(work?.title ? { workTitle: work.title } : {}),
  };
}

function findStatusLogWork(
  library: LibraryIndex | undefined,
  currentChapter: ChapterSnapshot | null | undefined,
  chapterId: string,
) {
  if (!library) return undefined;
  const currentWorkId =
    currentChapter?.id === chapterId ? currentChapter.workId : undefined;
  return library.works.find(
    (candidate) =>
      candidate.id === currentWorkId ||
      candidate.chapters.some((chapter) => chapter.id === chapterId),
  );
}

function getCurrentChapterTitle(
  currentChapter: ChapterSnapshot | null | undefined,
  chapterId: string,
): string | undefined {
  if (currentChapter?.id !== chapterId) return undefined;
  return currentChapter.title;
}

function sameStatusLogScope(
  current: StatusLogContext | undefined,
  next: StatusLogContext | undefined,
): boolean {
  if (current?.chapterId || next?.chapterId) {
    return current?.chapterId === next?.chapterId;
  }
  return true;
}
