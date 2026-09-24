import { McpPageEditService } from "../application/mcpPageEditService";
import type { McpOperationService } from "../application/mcpOperationService";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import { openChapter, savePageBlocks } from "../library";
import type { McpArtifactStore } from "./mcpArtifactStore";
import type { McpFileUploadStore } from "./mcpFileUploadStore";
import type { McpContextMigrationApplication } from "./mcpContextMigrationApplication";
import { McpContextExchangeApplication } from "./mcpContextExchangeApplication";
import { createMcpContextExchangeTools } from "./mcpContextExchangeTools";
import { createMcpTextExchangeTools } from "./mcpTextExchangeTools";
import { createMcpPageEditScope } from "./mcpPageEditScope";

/** Reuse the existing owned upload store, native page edit scope and context migration. */
export function createMcpExchangeSession(options: {
  app: InpaintingJobContext;
  operations: McpOperationService;
  artifacts: McpArtifactStore;
  uploads: McpFileUploadStore;
  migration: McpContextMigrationApplication;
  editing: {
    assertWritable: (chapterId: string, pageId: string) => Promise<void>;
    notifySaved: (chapterId: string, pageId: string) => void;
  };
  allowEditing: boolean;
}) {
  const lifetime = new AbortController();
  const tasks = new Set<Promise<unknown>>();
  const track = <T>(task: Promise<T>) => {
    tasks.add(task);
    return task.finally(() => {
      tasks.delete(task);
    });
  };
  const edits = new McpPageEditService({
    openChapter,
    savePageBlocks,
    ...options.editing,
    withPageEdit: createMcpPageEditScope(
      options.app,
      openChapter,
      lifetime.signal,
    ),
  });
  const text = createMcpTextExchangeTools({
    ...options,
    edits,
    lifetime: lifetime.signal,
  });
  const context = new McpContextExchangeApplication(
    options.uploads,
    options.migration,
    lifetime.signal,
  );
  return {
    tools: [
      ...text.tools,
      ...createMcpContextExchangeTools({
        ...options,
        imports: context,
        lifetime: lifetime.signal,
        track,
      }),
    ],
    stop: () => lifetime.abort(),
    close: async () => {
      lifetime.abort();
      await text.close();
      await Promise.allSettled([...tasks]);
    },
  };
}
