export const WEB_IMPORT_MAX_DISCOVERED_URLS = 5_000;
export const WEB_IMPORT_MAX_STAGED_BYTES = 2 * 1024 * 1024 * 1024;
export const WEB_IMPORT_SCAN_TIMEOUT_MS = 90_000;

export type WebImportSizeFilter = "all" | "medium-or-larger" | "large";
export type WebImportImageFormat = "jpeg" | "png" | "webp";
export type WebImportStoredExtension = ".jpg" | ".png";

export type WebImportCandidate = {
  id: string;
  previewUrl: string;
  width: number;
  height: number;
  pixelCount: number;
  byteSize: number;
  format: WebImportImageFormat;
  storedExtension: WebImportStoredExtension;
  pageIndex: number;
};

export type WebImportSkipCounts = {
  unsupported: number;
  failed: number;
  duplicate: number;
  blocked: number;
};

export type WebImportScanRequest = {
  requestId: string;
  url: string;
};

export type WebImportScanResult = {
  sessionId: string;
  pageTitle: string;
  sourceHost: string;
  candidates: WebImportCandidate[];
  skipped: WebImportSkipCounts;
  truncated: boolean;
};

export type WebImportScanRejectionReason =
  | "busy"
  | "cancelled"
  | "invalid-url"
  | "private-address"
  | "page-unavailable"
  | "timed-out";

export type WebImportScanResponse =
  | { status: "ready"; result: WebImportScanResult }
  | { status: "rejected"; reason: WebImportScanRejectionReason };

type WebImportProgressStage =
  | "validating"
  | "loading"
  | "scrolling"
  | "discovering"
  | "downloading";

export type WebImportProgressEvent = {
  requestId: string;
  stage: WebImportProgressStage;
  completed: number;
  total: number;
};

export type PrepareWebImportRequest = {
  sessionId: string;
  selectedCandidateIds: string[];
};

export type WebImportBooleanResult = {
  completed: boolean;
};
