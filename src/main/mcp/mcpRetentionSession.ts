import { withLibraryRead } from "../library/lock";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import type { McpArtifactStore } from "./mcpArtifactStore";
import { wrapRetainedTool } from "./mcpRecoveryCapture";
import { createRecoveryApplication } from "./mcpRecoveryApplication";
import { issueRetainedOutput } from "./mcpRetainedOutputs";
import { createMcpRetentionTools } from "./mcpRetentionTools";
import { McpRetentionCatalog } from "./mcpRetentionCatalog";

export function createMcpRetentionSession(
  storage: McpRetentionStorage,
  artifacts: McpArtifactStore,
  app: InpaintingJobContext,
  editing: Parameters<typeof createRecoveryApplication>[2],
  enabled: boolean,
  images: boolean,
) {
  const lifetime = new AbortController();
  const catalog = new McpRetentionCatalog(storage, lifetime.signal, images);
  const tasks = new Set<Promise<unknown>>();
  const apply = createRecoveryApplication(
    storage,
    app,
    editing,
    lifetime.signal,
  );
  const service = {
    list: catalog.list.bind(catalog),
    change: catalog.change.bind(catalog),
    output: catalog.output.bind(catalog),
    discard: catalog.discard.bind(catalog),
    file: (owner: string, id: string, guard: () => void) =>
      issueRetainedOutput(storage, artifacts, owner, id, () => {
        lifetime.signal.throwIfAborted();
        guard();
      }),
    apply: (...args: Parameters<typeof apply>) => {
      const task = apply(...args);
      tasks.add(task);
      return task.finally(() => {
        tasks.delete(task);
      });
    },
  };
  return {
    tools: createMcpRetentionTools(service, enabled, images),
    wrap: (tool: Parameters<typeof wrapRetainedTool>[1]) =>
      wrapRetainedTool(storage, tool),
    ready: () => withLibraryRead(() => storage.index()),
    stop: () => lifetime.abort(),
    close: async () => {
      lifetime.abort();
      await Promise.allSettled([...tasks]);
    },
  };
}
