import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { McpConfiguration } from "./mcpConfiguration";
import {
  authorizeMcpRequest,
  McpHttpError,
  validateMcpHost,
  validateMcpPost,
} from "./mcpHttpPolicy";
import { handleMcpMessage, type McpHttpReply } from "./mcpProtocol";
import type { McpTool } from "./mcpReadTools";
import { readMcpBody } from "./mcpRequestBody";
import { McpOAuthHttp } from "./mcpOAuthHttp";

export type McpHttpServer = {
  url: string;
  stopAccepting: () => void;
  close: () => Promise<void>;
};
type ServerOptions = {
  config: McpConfiguration;
  oauth?: McpOAuthHttp;
  tools: readonly McpTool[];
  authorizeTool?: (authorization: string, tool: McpTool) => boolean;
  reportError: (error: unknown) => void;
};

export async function startMcpHttpServer(
  options: ServerOptions,
): Promise<McpHttpServer> {
  const config = { ...options.config };
  if (config.oauthPassword && !config.publicOrigin)
    throw new Error("OAuth requires an HTTPS public origin.");
  const oauth =
    options.oauth ??
    (config.oauthPassword && config.publicOrigin
      ? new McpOAuthHttp(config.publicOrigin, config.oauthPassword)
      : undefined);
  if (oauth && oauth.provider.issuer !== config.publicOrigin)
    throw new Error("OAuth public origin mismatch.");
  const handler = createRequestHandler(options, config, oauth);
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    void handler.serve(request, response);
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 75_000;
  server.maxConnections = 32;
  let closing: Promise<void> | undefined;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", options.reportError);
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("MCP listener address is unavailable.");
  config.port = address.port;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    stopAccepting: handler.stopAccepting,
    close: () => {
      handler.stopAccepting();
      closing ??= Promise.all([
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
        oauth?.close(),
      ]).then(() => undefined);
      return closing;
    },
  };
}

function createRequestHandler(
  options: ServerOptions,
  config: McpConfiguration,
  oauth?: McpOAuthHttp,
) {
  let accepting = true;
  let active = 0;
  async function serve(request: IncomingMessage, response: ServerResponse) {
    let counted = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      validateMcpHost(request, config);
      if (!accepting) throw new McpHttpError(503, "MCP server is stopping.");
      if (active >= 8)
        throw new McpHttpError(429, "Too many concurrent requests.");
      active++;
      counted = true;
      deadline = setTimeout(() => {
        sendFailure(
          response,
          new McpHttpError(504, "MCP read timed out."),
          oauth,
        );
      }, 30_000);
      deadline.unref();
      if (await oauth?.handle(request, response)) return;
      authorizeMcpRequest(
        request,
        config,
        oauth && ((header) => oauth.accepts(header)),
      );
      if (request.url !== "/mcp") throw new McpHttpError(404, "Not found.");
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        throw new McpHttpError(
          405,
          "SSE and session deletion are not offered.",
        );
      }
      validateMcpPost(request);
      sendReply(
        response,
        await handleMcpMessage(
          await readMcpBody(request),
          options.tools,
          options.reportError,
          (tool) =>
            accepting &&
            !response.destroyed &&
            !response.writableEnded &&
            (options.authorizeTool?.(
              request.headers.authorization ?? "",
              tool,
            ) ??
              true),
        ),
      );
    } catch (error) {
      if (!(error instanceof McpHttpError)) options.reportError(error);
      sendFailure(response, error, oauth);
    } finally {
      clearTimeout(deadline);
      if (counted) active--;
    }
  }
  return {
    serve,
    stopAccepting: () => {
      accepting = false;
      oauth?.stop();
    },
  };
}

function sendFailure(
  response: ServerResponse,
  error: unknown,
  oauth?: McpOAuthHttp,
) {
  if (response.destroyed || response.writableEnded) return;
  const status = error instanceof McpHttpError ? error.status : 500;
  const message =
    error instanceof McpHttpError ? error.message : "Internal server error.";
  response.setHeader("Connection", "close");
  if (status === 401)
    response.setHeader(
      "WWW-Authenticate",
      oauth?.challenge() ?? 'Bearer realm="carrot-mcp"',
    );
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
