import type { McpOutputSyncOptions } from "./mcpOutputSyncTypes";
import { createMcpOutputSyncTools } from "./mcpOutputSyncTools";
import { diagnoseMcpOutputSync } from "./mcpOutputSyncInspection";
import { withMcpAuthorization } from "./mcpAuthorizationScope";

/** One supplied receipt authority; closing awaits every physical writer and settlement. */
export function createMcpOutputSyncSession(options: McpOutputSyncOptions) {
  const lifetime = new AbortController();
  const tasks = new Set<Promise<unknown>>();
  const track = <T>(task: Promise<T>) => {
    tasks.add(task);
    return task.finally(() => {
      tasks.delete(task);
    });
  };
  return {
    tools: createMcpOutputSyncTools(options, lifetime.signal, track),
    diagnose: (owner: string, id: string, guard: () => void) =>
      track(
        withMcpAuthorization(guard, lifetime.signal, (check) =>
          diagnoseMcpOutputSync(options, owner, id, check),
        ),
      ),
    stop: () => lifetime.abort(),
    close: async () => {
      lifetime.abort();
      while (tasks.size) await Promise.allSettled([...tasks]);
    },
  };
}
