import { McpLibraryReadService } from "./application/mcpLibraryReadService";
import { listLibrary, openChapter } from "./library";
import { readMcpConfiguration } from "./mcp/mcpConfiguration";
import { startMcpHttpServer } from "./mcp/mcpHttpServer";
import { createMcpReadTools } from "./mcp/mcpReadTools";
import { McpServerLifecycle } from "./mcp/mcpServerLifecycle";

type RuntimeOptions = {
  env: NodeJS.ProcessEnv;
  reportError: (message: string, detail?: unknown) => void;
  reportInfo: (message: string, detail?: unknown) => void;
};

/** Composition only. The app's existing facade owns all library access and locks. */
export function createMcpRuntime(options: RuntimeOptions): McpServerLifecycle {
  return new McpServerLifecycle(async () => {
    const config = readMcpConfiguration(options.env);
    if (!config) return null;
    const service = new McpLibraryReadService({ listLibrary, openChapter });
    const server = await startMcpHttpServer({
      config,
      tools: createMcpReadTools(service),
      reportError: (error) => options.reportError("MCP read failed", error),
    });
    options.reportInfo("MCP read-only server listening", {
      url: server.url,
      publicOrigin: config.publicOrigin ?? null,
    });
    return server;
  });
}
