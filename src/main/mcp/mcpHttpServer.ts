import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { McpConfiguration } from "./mcpConfiguration";
import { authorizeMcpRequest, McpHttpError, validateMcpPost } from "./mcpHttpPolicy";
import { handleMcpMessage, type McpHttpReply } from "./mcpProtocol";
import type { McpTool } from "./mcpReadTools";
import { readMcpBody } from "./mcpRequestBody";

export type McpHttpServer = {
  url: string;
  stopAccepting: () => void;
  close: () => Promise<void>;
};

type ServerOptions = {
  config: McpConfiguration;
  tools: readonly McpTool[];
  reportError: (error: unknown) => void;
};

export async function startMcpHttpServer(options: ServerOptions): Promise<McpHttpServer> {
  let accepting = true;
  let active = 0;
  let config = { ...options.config };
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    void serve(request, response);
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 32;
  let closing: Promise<void> | undefined;

  async function serve(request: IncomingMessage, response: ServerResponse) {
    let counted = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      authorizeMcpRequest(request, config);
      if (request.url !== "/mcp") throw new McpHttpError(404, "Not found.");
      if (!accepting) throw new McpHttpError(503, "MCP server is stopping.");
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        throw new McpHttpError(405, "SSE and session deletion are not offered.");
      }
      validateMcpPost(request);
      if (active >= 8) throw new McpHttpError(429, "Too many concurrent requests.");
      active++;
      counted = true;
      deadline = setTimeout(() => {
        sendFailure(response, new McpHttpError(504, "MCP read timed out."));
      }, 30_000);
      deadline.unref();
      const message = await readMcpBody(request);
      sendReply(response, await handleMcpMessage(message, options.tools, options.reportError));
    } catch (error) {
      if (!(error instanceof McpHttpError)) options.reportError(error);
      sendFailure(response, error);
    } finally {
      clearTimeout(deadline);
      if (counted) active--;
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", options.reportError);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP listener address is unavailable.");
  config = { ...config, port: address.port };
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    stopAccepting: () => { accepting = false; },
    close: () => {
      accepting = false;
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

function sendFailure(response: ServerResponse, error: unknown) {
  if (response.destroyed || response.writableEnded) return;
  const status = error instanceof McpHttpError ? error.status : 500;
  const message = error instanceof McpHttpError ? error.message : "Internal server error.";
  response.setHeader("Connection", "close");
  if (status === 401) response.setHeader("WWW-Authenticate", 'Bearer realm="carrot-mcp"');
  if (status === 429) response.setHeader("Retry-After", "1");
  sendReply(response, { status, body: { error: message } });
}

function sendReply(response: ServerResponse, reply: McpHttpReply) {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = reply.status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (reply.body === undefined) response.end();
  else {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(reply.body));
  }
}
