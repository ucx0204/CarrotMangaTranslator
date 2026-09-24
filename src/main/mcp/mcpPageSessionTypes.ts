import type { McpLibraryChangedEvent } from "../../shared/mcpEditingTypes";
import type { McpPreferences } from "../../shared/mcpDesktopTypes";
import type { McpJobPersistence } from "../application/mcpJobJournal";
import type { McpOperationService } from "../application/mcpOperationService";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { ReviewedLinkedOutputPort } from "../linkedWorkspace/linkedWorkspaceReviewedOutputTypes";
import type {
  McpRetentionStorage,
  McpRetentionCodec,
} from "./mcpRetentionStorage";
import type { createMcpRetentionSession } from "./mcpRetentionSession";
import type { McpArtifactStore } from "./mcpArtifactStore";
import type { McpOutputSyncRepository } from "./mcpOutputSyncRepository";
import type { McpCompositeRepository } from "./mcpCompositeRepository";

export type McpPageSessionEditing = {
  assertChapterClosed?: (chapterId: string) => Promise<void>;
  notifyLibraryChanged?: (event: McpLibraryChangedEvent) => void;
  assertWritable: (chapterId: string, pageId: string) => Promise<void>;
  assertClean: (chapterId: string, pageId: string) => Promise<void>;
  notifySaved: (chapterId: string, pageId: string) => void;
};

/** Trusted application ports shared by the page session and its auxiliary composition. */
export type PageSessionOptions = {
  origin: string;
  jobPersistence?: McpJobPersistence;
  retentionCodec?: McpRetentionCodec;
  preferences: McpPreferences;
  app: InpaintingJobContext;
  outputSync?: ReviewedLinkedOutputPort;
  editing: McpPageSessionEditing;
  reportError: (error: unknown) => void;
};

/** Existing session-owned authorities; auxiliary modules never create competing stores. */
export type McpPageSessionResources = {
  operations: McpOperationService;
  artifacts: McpArtifactStore;
  storage?: McpRetentionStorage;
  retained?: ReturnType<typeof createMcpRetentionSession>;
  outputSyncReceipts?: McpOutputSyncRepository;
  compositeRepository?: McpCompositeRepository;
};
