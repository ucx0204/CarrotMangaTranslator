import type { PageVisualRevision } from "./pageRevision";

export const LINKED_WORKSPACE_SCHEMA_VERSION = 1 as const;
export const LINKED_SYNC_QUEUE_SCHEMA_VERSION = 1 as const;

export type RasterExportFormat = "source" | "png" | "jpeg" | "webp";
type ExportCollisionPolicy = "replace" | "skip" | "cancel";
type ExportDestinationMode = "timestamped" | "fixed";

export type RasterExportSettings = {
  format: RasterExportFormat;
  jpegQuality: number;
  webpQuality: number;
  preserveSourceNames: boolean;
  destinationMode: ExportDestinationMode;
  collisionPolicy: ExportCollisionPolicy;
};

export type LinkedWorkspaceDestinationKind = "managed" | "custom";

export const DEFAULT_RASTER_EXPORT_SETTINGS: RasterExportSettings = {
  format: "source",
  jpegQuality: 95,
  webpQuality: 90,
  preserveSourceNames: true,
  destinationMode: "timestamped",
  collisionPolicy: "replace",
};

export type LinkedWorkspaceRecordV1 = {
  id: string;
  workId: string;
  chapterId: string;
  rootPath: string;
  /** Missing on v1 records created before managed result folders existed. */
  destinationKind?: LinkedWorkspaceDestinationKind;
  enabled: boolean;
  output: RasterExportSettings;
  pageRelativePaths: Record<string, string>;
  /** Dedicated result folders keep recoverable source copies under `originals/`. */
  sourceRelativePaths?: Record<string, string>;
  publishedRevisions: Record<string, PageVisualRevision>;
  publishedMirrorRevisions: Record<string, string>;
  sourceFingerprints: Record<
    string,
    { size: number; mtimeMs: number; sha256: string }
  >;
  artifacts: Record<
    string,
    {
      result?: { path: string; bytes: number; sha256: string };
      inpainted?: {
        path: string;
        bytes: number;
        sha256: string;
        /** Local-only source artifact path; never written to the recovery mirror. */
        sourcePath?: string;
      };
      mask?: {
        path: string;
        bytes: number;
        sha256: string;
        /** Local-only source artifact path; never written to the recovery mirror. */
        sourcePath?: string;
      };
    }
  >;
  createdAt: string;
  updatedAt: string;
};

export type LinkedWorkspaceRegistryV1 = {
  schemaVersion: typeof LINKED_WORKSPACE_SCHEMA_VERSION;
  records: LinkedWorkspaceRecordV1[];
};

export type LinkedSyncQueueItemV1 = {
  connectionId: string;
  chapterId: string;
  pageId: string;
  visualRevision: PageVisualRevision;
  mirrorRevision: string;
  priority: number;
  attempts: number;
  nextRetryAt: number;
  queuedAt: number;
  /** Import-time metadata mirror update that deliberately does not render result pixels. */
  mirrorOnly?: boolean;
};

export type LinkedSyncQueueFileV1 = {
  schemaVersion: typeof LINKED_SYNC_QUEUE_SCHEMA_VERSION;
  items: LinkedSyncQueueItemV1[];
};

type LinkedWorkspaceSyncState =
  | "unlinked"
  | "disabled"
  | "idle"
  | "pending"
  | "syncing"
  | "failed";

export type LinkedWorkspaceStatus = {
  chapterId: string;
  connectionId?: string;
  state: LinkedWorkspaceSyncState;
  pendingCount: number;
  failedCount: number;
  rootPath?: string;
  rootName?: string;
  destinationKind?: LinkedWorkspaceDestinationKind;
  outputFormat?: RasterExportFormat;
  notice?: string;
  lastError?: string;
};

export type LinkedWorkspaceImportOptions = {
  enabled: boolean;
  outputFormat: RasterExportFormat;
  jpegQuality: number;
  webpQuality: number;
};

export type ConnectLinkedWorkspaceRequest = {
  workId: string;
  chapterId: string;
  output: RasterExportSettings;
  /** Main-process-only custom destination. Renderer calls are forced to managed. */
  rootPath?: string;
  /** Renderer calls are forced to managed; folder pickers create custom records. */
  destinationKind?: LinkedWorkspaceDestinationKind;
  enqueueExistingPages?: boolean;
};

export type UpdateLinkedWorkspaceRequest = {
  connectionId: string;
  enabled?: boolean;
  output?: RasterExportSettings;
};

export type ViewLinkedResultsRequest = {
  chapterId: string;
  currentPageId?: string;
};

export type ViewLinkedResultsResult =
  | { status: "opened"; syncedPages: number }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

export type LinkedWorkspaceBooleanResult = { completed: boolean };

export type LinkedWorkspaceActivityRequest =
  | { type: "pulse" }
  | { type: "start" | "end"; interaction: "pointer" | "composition" };

export type LinkedWorkspaceStatusChangedEvent = {
  statuses: LinkedWorkspaceStatus[];
};
