import type { WorkShareImportResult } from "../../shared/shareTypes";
import type { ChapterFile } from "./libraryFiles";
import type { LibraryTransaction } from "./libraryTransaction";
import type {
  NativeImportPageObserver,
  NativeImportMetadataObserver,
} from "./importPublicationEvidence";

/** Native callers join a verified receipt to the existing share transaction. */
export type ShareImportPublication = {
  assertCanCommit: () => void;
  observePage?: NativeImportPageObserver;
  observeMetadata?: NativeImportMetadataObserver;
  /** Trusted append adapter: only remaps reviewed incoming references. */
  mapChapter?: (chapter: ChapterFile) => ChapterFile;
  stage: (
    transaction: LibraryTransaction,
    result: WorkShareImportResult,
  ) => Promise<void>;
};
