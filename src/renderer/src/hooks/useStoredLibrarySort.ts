import React from "react";
import {
  readLibrarySort,
  writeLibrarySort,
  type LibrarySort,
} from "../lib/librarySort";

export function useStoredLibrarySort(): readonly [
  LibrarySort,
  (next: LibrarySort) => void,
] {
  const [sort, setSort] = React.useState<LibrarySort>(() => readLibrarySort());
  const handleChange = React.useCallback((next: LibrarySort) => {
    setSort(next);
    writeLibrarySort(next);
  }, []);
  return [sort, handleChange] as const;
}
