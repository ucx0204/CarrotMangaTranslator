import type { ImportSourceKind } from "./libraryTypes";

export const APP_OPERATION_KINDS = [
  "library-import",
  "library-import-preview",
  "web-import-preview",
  "work-share-import",
  "work-share-export",
  "model-test",
  "codex-auth",
] as const;

export type AppOperationKind = (typeof APP_OPERATION_KINDS)[number];

export const APP_OPERATION_STATUSES = [
  "running",
  "cancelling",
  "cancelled",
  "failed",
  "completed",
] as const;

export type AppOperationStatus = (typeof APP_OPERATION_STATUSES)[number];

export const APP_OPERATION_PHASES = [
  "import-source-reading",
  "import-source-converting",
  "import-source-validating",
  "import-library-saving-current",
  "import-library-writing",
  "import-finalizing",
  "web-validating",
  "web-loading",
  "web-scrolling",
  "web-discovering",
  "web-downloading",
  "web-preparing",
  "share-reading",
  "share-packaging",
  "share-applying",
  "model-test-preparing",
  "model-test-downloading",
  "model-test-checking",
  "codex-auth-opening-browser",
  "codex-auth-updating",
  "waiting-for-user",
] as const;

export type AppOperationPhase = (typeof APP_OPERATION_PHASES)[number];

export const APP_OPERATION_PROGRESS_UNITS = [
  "items",
  "bytes",
  "percent",
] as const;

type AppOperationProgressUnit = (typeof APP_OPERATION_PROGRESS_UNITS)[number];

export type AppOperationActivityEvent = {
  id: string;
  kind: AppOperationKind;
  status: AppOperationStatus;
  phase?: AppOperationPhase;
  sourceKind?: ImportSourceKind;
  progressCurrent?: number;
  progressTotal?: number;
  progressUnit?: AppOperationProgressUnit;
  waitingForUser?: boolean;
  failureCode?: string;
  mutatesLibrary: boolean;
  cancellable: boolean;
  startedAt: number;
  updatedAt: number;
};

export type AppOperationCancelResult = {
  accepted: boolean;
};
