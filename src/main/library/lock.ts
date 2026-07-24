import { AsyncReaderWriterLock } from "../libraryStore/mutex";

const libraryLock = new AsyncReaderWriterLock();

export function withLibraryMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return libraryLock.runWrite(operation);
}

export function withLibraryRead<T>(operation: () => Promise<T>): Promise<T> {
  return libraryLock.runRead(operation);
}

/**
 * Navigation reads observe JSON files published through atomic temp-file
 * renames, so they can safely see either the previous or next snapshot without
 * waiting behind an unrelated long-running mutation. Multi-file readers in the
 * navigation facade already treat removed index references as absent.
 *
 * Exports and context operations that require a stable multi-file snapshot must
 * continue to use {@link withLibraryRead}.
 */
export function withLibraryNavigationRead<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return operation();
}
