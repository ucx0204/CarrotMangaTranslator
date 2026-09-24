import type {
  ChapterSnapshot,
  LibraryIndex,
  MangaPage,
} from "../../shared/libraryTypes";
import type { LinkedWorkspaceRecordV1 } from "../../shared/linkedWorkspaceTypes";
import type { AtomicFilePublication } from "../libraryStore/storage";
import type { PageExportRenderSession } from "../pageExport";
import type {
  ReviewedOutputDigest,
  ReviewedOutputFile,
  ReviewedOutputPreflight,
} from "./linkedWorkspaceReviewedOutputTypes";

export type NativeLinkedOutputOwner = {
  dataRoot: string;
  appVersion: () => string;
  available: () => boolean;
  reportError: (message: string, detail?: unknown) => void;
  records: () => LinkedWorkspaceRecordV1[];
  storedRecords: () => Promise<LinkedWorkspaceRecordV1[]>;
  allocate: (
    record: LinkedWorkspaceRecordV1,
    chapter: ChapterSnapshot,
  ) => LinkedWorkspaceRecordV1;
  listLibrary: () => Promise<LibraryIndex>;
  openChapter: (id: string) => Promise<ChapterSnapshot>;
  createRenderer: () => Promise<PageExportRenderSession>;
  commit: (
    expected: LinkedWorkspaceRecordV1[],
    records: LinkedWorkspaceRecordV1[],
    publication: AtomicFilePublication,
  ) => Promise<void>;
};

export type ReviewedSource = {
  chapterId: string;
  pageId: string;
  path: string;
  digest: ReviewedOutputDigest;
};
export type ReviewedNativeFile = ReviewedOutputFile & {
  relativePath: string | null;
  sourcePath: string | null;
  desired: ReviewedOutputDigest | null;
};
export type ReviewedNativePage = {
  page: MangaPage;
  recordId: string;
  captureFormat: "png" | "jpeg" | "webp";
  files: ReviewedNativeFile[];
};
export type ReviewedNativeInput = {
  rootPath: string;
  rootIdentity: string;
  records: LinkedWorkspaceRecordV1[];
  chapters: ChapterSnapshot[];
  workTitles: Map<string, string>;
  selectionSnapshot: string;
  destinationSnapshot: string;
};
export type ReviewedNativePlan = ReviewedNativeInput & {
  review: ReviewedOutputPreflight;
  pages: ReviewedNativePage[];
  sources: ReviewedSource[];
  targets: Map<string, ReviewedOutputDigest | null>;
  files: ReviewedNativeFile[];
};
export type ReviewedNativeState = {
  records: LinkedWorkspaceRecordV1[];
  targets: Map<string, ReviewedOutputDigest | null>;
};
