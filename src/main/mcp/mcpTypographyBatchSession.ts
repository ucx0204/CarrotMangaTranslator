import { McpTypographyBatchPreviewSchema } from "../../shared/mcpTypographyBatch";
import {
  McpTranslationBatchGetSchema,
  McpTranslationBatchActionSchema,
} from "../../shared/mcpTranslationBatch";
import { McpPageBatchService } from "../application/mcpPageBatchService";
import { createMcpTypographyBatchPolicy } from "../application/mcpTypographyBatchPolicy";
import { McpPageEditService } from "../application/mcpPageEditService";
import type { McpOperationService } from "../application/mcpOperationService";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import { openChapter, savePageBlocks } from "../library";
import { createMcpBatchTool } from "./mcpBatchTool";
import { createMcpPageEditScope } from "./mcpPageEditScope";
import { createMcpTypographyBatchAdapter } from "./mcpTypographyBatchAdapter";

const scopes = ["carrot.read", "carrot.edit", "carrot.process"];
type Editing = {
  assertWritable: (chapterId: string, pageId: string) => Promise<void>;
  notifySaved: (chapterId: string, pageId: string) => void;
};

export function createMcpTypographyBatchSession(
  app: InpaintingJobContext,
  operations: McpOperationService,
  editing: Editing,
  enabled: boolean,
) {
  const lifetime = new AbortController();
  const edits = new McpPageEditService({
    openChapter,
    savePageBlocks,
    ...editing,
    withPageEdit: createMcpPageEditScope(app, openChapter, lifetime.signal),
  });
  const adapter = createMcpTypographyBatchAdapter(edits, operations);
  const service = new McpPageBatchService(
    adapter.ports,
    createMcpTypographyBatchPolicy(adapter.planning),
    Date.now,
    lifetime.signal,
  );
  return {
    tools: enabled ? typographyTools(service) : [],
    stop: () => lifetime.abort(),
    close: async () => {
      lifetime.abort();
      await service.close();
    },
  };
}

type Service = McpPageBatchService<
  ...never[]
>;
