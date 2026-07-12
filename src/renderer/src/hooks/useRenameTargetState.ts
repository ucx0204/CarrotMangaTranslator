import { useCallback } from "react";
import type { RenameTarget } from "../lib/libraryRenameTypes";
import type { ChapterSnapshot, LibraryIndex } from "./libraryActionTypes";

type RenameTargetStateOptions = {
  currentChapter: ChapterSnapshot | null;
  library: LibraryIndex;
  setRenameTarget: (target: RenameTarget | null) => void;
};

function findRenameableChapter(
  library: LibraryIndex,
  currentChapter: ChapterSnapshot | null,
  chapterId: string,
): Pick<ChapterSnapshot, "id" | "title"> | null {
  return (
    library.works
      .flatMap((work) => work.chapters)
      .find((candidate) => candidate.id === chapterId) ??
    (currentChapter
      ? { id: currentChapter.id, title: currentChapter.title }
      : null)
  );
}

export function useRenameTargetState({
  currentChapter,
  library,
  setRenameTarget,
}: RenameTargetStateOptions): {
  renameChapter: (chapterId: string) => void;
  renameWork: (workId: string) => void;
} {
  const renameWork = useCallback(
    (workId: string) => {
      const work = library.works.find((candidate) => candidate.id === workId);
      if (work) {
        setRenameTarget({ kind: "work", id: workId, title: work.title });
      }
    },
    [library.works, setRenameTarget],
  );

  const renameChapter = useCallback(
    (chapterId: string) => {
      const chapter = findRenameableChapter(library, currentChapter, chapterId);
      if (chapter) {
        setRenameTarget({
          kind: "chapter",
          id: chapterId,
          title: chapter.title,
        });
      }
    },
    [currentChapter, library, setRenameTarget],
  );

  return { renameChapter, renameWork };
}
