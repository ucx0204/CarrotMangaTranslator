import { AsyncReaderWriterLock } from "./mutex";

const publicationLock = new AsyncReaderWriterLock();

export function withLibraryPublicationRead<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return publicationLock.runRead(operation);
}

export function withLibraryPublicationWrite<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return publicationLock.runWrite(operation);
}
