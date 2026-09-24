import type { RasterExportSettings } from "../../shared/linkedWorkspaceTypes";

export const REVIEWED_OUTPUT_LIMITS = {
  selectedPages: 50,
  mirrorChapters: 10,
  mirrorPages: 50,
  externalFiles: 301,
  registryPublications: 51,
  receiptFiles: 352,
  imageBytes: 67108864,
  mirrorBytes: 16777216,
  publishedBytes: 268435456,
} as const;

type ReviewedOutputRole =
  | "result"
  | "inpainted"
  | "mask"
  | "mirror"
  | "registry";
export type ReviewedOutputDigest = { bytes: number; sha256: string };
export type ReviewedOutputSelection = {
  chapterId: string;
  connectionId: string;
  pageIds: string[];
};
type ReviewedOutputBinding = {
  selectionSnapshot: string;
  destinationSnapshot: string;
  sourceSnapshot: string;
};
type ReviewedOutputTarget = ReviewedOutputSelection & ReviewedOutputBinding;

export type ReviewedOutputErrorCode =
  | "destination_unavailable"
  | "destination_changed"
  | "selection_changed"
  | "source_changed"
  | "unmanaged_collision"
  | "unsafe_path"
  | "legacy_preparation_required"
  | "limit_exceeded"
  | "publication_failed"
  | "receipt_failed";

export class ReviewedOutputError extends Error {
  constructor(
    readonly code: ReviewedOutputErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ReviewedOutputError";
  }
}

type ReviewedOutputMirrorScope = {
  chapters: {
    connectionId: string;
    chapterId: string;
    pageIds: string[];
  }[];
  pageCount: number;
  includesSavedText: true;
};
export type ReviewedOutputDestination = {
  chapterId: string;
  connectionId: string | null;
  destinationKind: "managed" | "custom" | null;
  enabled: boolean;
  available: boolean;
  reason: ReviewedOutputErrorCode | null;
  output: RasterExportSettings | null;
  mirrorScope: ReviewedOutputMirrorScope | null;
};

export type ReviewedOutputFile = {
  fileId: string;
  role: ReviewedOutputRole;
  pageId: string | null;
  action: "publish" | "remove";
  previous: ReviewedOutputDigest | null;
};
export type ReviewedOutputPreflight = ReviewedOutputSelection &
  ReviewedOutputBinding & {
    pages: {
      pageId: string;
      revision: string;
      visualRevision: string;
      format: "png" | "jpeg" | "webp";
    }[];
    mirrorScope: ReviewedOutputMirrorScope;
    files: ReviewedOutputFile[];
    limits: typeof REVIEWED_OUTPUT_LIMITS;
    registryPublications: { maximum: number; privateMetadataOnly: true };
    executionReserved: false;
    partialPublication: true;
  };

/** Private native receipt event. relativePath never reaches public metadata.
 * Registry events have no root-relative path. No absolute paths or URLs occur. */
export type ReviewedOutputIntent = ReviewedOutputFile & {
  relativePath: string | null;
  desired: ReviewedOutputDigest | null;
};
export type ReviewedOutputEffect = {
  fileId: string;
  state: "published" | "removed";
  bytes: number;
  sha256: string | null;
  completedAt: number;
};
export type ReviewedOutputFileOutcome = ReviewedOutputFile & {
  state:
    | "planned"
    | "publication_unconfirmed"
    | "published"
    | "removed"
    | "failed";
  bytes: number | null;
  sha256: string | null;
  completedAt: number | null;
};
export type ReviewedOutputResult = {
  status: "completed" | "partial" | "cancelled" | "failed";
  errorCode: ReviewedOutputErrorCode | null;
  files: ReviewedOutputFileOutcome[];
  publishedBytes: number;
  metadata: "pending" | "partial" | "published" | "publication_unconfirmed";
  mirror: "pending" | "published" | "publication_unconfirmed";
};

export type ReviewedOutputExecution = {
  signal: AbortSignal;
  assertAuthorized: () => void;
  /** Must durably record this exact intent before allowing an OS effect. */
  onIntent: (intent: ReviewedOutputIntent) => Promise<void>;
  /** Settles only the admitted intent; must not authorize more file writes. */
  onEffect: (effect: ReviewedOutputEffect) => Promise<void>;
  onProgress?: (progress: {
    phase: "rendering" | "publishing" | "mirror" | "done";
    completed: number;
    total: number;
  }) => void;
};

type ReviewedOutputEvidenceState =
  | "matches_planned"
  | "matches_previous"
  | "missing"
  | "changed"
  | "unavailable"
  | "not_checked";
export type ReviewedOutputEvidenceInput = {
  selection: ReviewedOutputSelection;
  destinationSnapshot: string;
  /** Admitted intents loaded by the receipt authority. Paths remain private. */
  targets: ReviewedOutputIntent[];
};
export type ReviewedOutputEvidence = {
  extent: "current-destination-files-only";
  sourceChecked: false;
  destination: "matched" | "unavailable";
  checkedAt: number;
  files: {
    fileId: string;
    currentState: ReviewedOutputEvidenceState;
    bytes: number | null;
    sha256: string | null;
  }[];
};

export type ReviewedLinkedOutputPort = {
  inspect: (
    chapterId: string,
    guard: () => void,
  ) => Promise<ReviewedOutputDestination>;
  preflight: (
    selection: ReviewedOutputSelection,
    guard: () => void,
  ) => Promise<ReviewedOutputPreflight>;
  execute: (
    target: ReviewedOutputTarget,
    context: ReviewedOutputExecution,
  ) => Promise<ReviewedOutputResult>;
  inspectReceiptEvidence: (
    input: ReviewedOutputEvidenceInput,
    guard: () => void,
  ) => Promise<ReviewedOutputEvidence>;
};
