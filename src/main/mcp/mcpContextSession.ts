import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { McpPreferences } from "../../shared/mcpDesktopTypes";
import type { McpOperationService } from "../application/mcpOperationService";
import { McpContextProposalService } from "../application/mcpContextProposalService";
import { readWorkContextForEdit, commitWorkContextEdit } from "../library";
import { withMcpContextEditScope } from "./mcpContextEditScope";
import { createMcpContextEditingTools } from "./mcpContextTools";
import { createMcpContextResearchExecutor } from "./mcpContextResearchAdapter";
import { createMcpContextResearchTool } from "./mcpContextResearchTool";

export function createMcpContextSession(
  app: InpaintingJobContext,
  operations: McpOperationService,
  preferences: McpPreferences,
) {
  const proposals = new McpContextProposalService({
    read: readWorkContextForEdit,
    commit: commitWorkContextEdit,
    withEdit: withMcpContextEditScope,
  });
  return {
    tools: [
      ...createMcpContextEditingTools(proposals, preferences.allowEditing),
      ...(preferences.allowProcessing
        ? [
            createMcpContextResearchTool(
              operations,
              createMcpContextResearchExecutor(app, proposals),
            ),
          ]
        : []),
    ],
    stop: () => proposals.stop(),
    close: () => proposals.close(),
  };
}
