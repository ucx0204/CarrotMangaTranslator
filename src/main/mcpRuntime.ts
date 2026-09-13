import { listLibrary, openChapter } from "./library";
import { readMcpConfiguration } from "./mcp/mcpConfiguration";
import { startMcpHttpServer } from "./mcp/mcpHttpServer";
import { renderMcpPagePreview } from "./mcp/mcpPreviewImage";
import { McpServerLifecycle } from "./mcp/mcpServerLifecycle";
import { createMcpToolSet } from "./mcp/mcpToolSet";

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
    const server = await startMcpHttpServer({
      config,
      tools: createMcpToolSet(
        { listLibrary, openChapter },
        config.allowImages ? renderMcpPagePreview : undefined,
        config.oauthPassword !== undefined,
      ),
      reportError: (error) => options.reportError("MCP read failed", error),
    });
    options.reportInfo("MCP read-only server listening", {
      url: server.url,
      publicOrigin: config.publicOrigin ?? null,
      imageTransfer: config.allowImages === true,
      oauth: config.oauthPassword !== undefined,
    });
    return server;
  });
}
