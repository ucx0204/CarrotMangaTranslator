import type { McpPreferences } from "../../shared/mcpDesktopTypes";
import type { ReviewedLinkedOutputPort } from "../linkedWorkspace/linkedWorkspaceReviewedOutputTypes";
import type { McpOperationService } from "../application/mcpOperationService";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { McpOutputSyncRepository } from "./mcpOutputSyncRepository";

export type McpOutputSyncOptions = {
  app: InpaintingJobContext;
  operations: McpOperationService;
  repository: McpOutputSyncRepository;
  port?: ReviewedLinkedOutputPort;
  preferences: McpPreferences;
  editing: {
    assertClean: (chapterId: string, pageId: string) => Promise<void>;
  };
  reportError: (error: unknown) => void;
};
