import { AsyncReaderWriterLock } from "../libraryStore/mutex";

const libraryLock = new AsyncReaderWriterLock();

export function withLibraryMutation<T>(operation: () => Promise<T>): Promise<T> {
  return libraryLock.runWrite(operation);
}

export function withLibraryRead<T>(operation: () => Promise<T>): Promise<T> {
  return libraryLock.runRead(operation);
}
