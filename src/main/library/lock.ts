import { AsyncReaderWriterLock } from "../libraryStore/mutex";
import {
  assertLibraryReadable,
  libraryMutationCoordinator,
} from "../libraryStore/libraryMutationCoordinator";
import { withLibraryPublicationRead } from "../libraryStore/libraryPublicationLock";

const libraryLock = new AsyncReaderWriterLock();

export function withLibraryMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const lease = libraryMutationCoordinator.begin();
  return libraryLock
    .runWrite(async () => {
      libraryMutationCoordinator.assertExecutionAllowed();
      return operation();
    })
    .finally(lease.finish);
}

export function withLibraryRead<T>(operation: () => Promise<T>): Promise<T> {
  assertLibraryReadable();
  return libraryLock.runRead(async () => {
    assertLibraryReadable();
    return operation();
  });
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
  assertLibraryReadable();
  return withLibraryPublicationRead(async () => {
    assertLibraryReadable();
    return operation();
  });
}
