import { McpEditError } from "../application/mcpEditPolicy";
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
  tools: readonly McpTool[];
  reportError: (error: unknown) => void;
  oauthHttp?: McpOAuthHttp;
  enforceScopes?: boolean;
};

export async function startMcpHttpServer(
  options: ServerOptions,
): Promise<McpHttpServer> {
  const config = { ...options.config };
  if (config.oauthPassword && !config.publicOrigin)
    throw new Error("OAuth requires an HTTPS public origin.");
  const oauth =
    options.oauthHttp ??
    (config.oauthPassword && config.publicOrigin
      ? new McpOAuthHttp(config.publicOrigin, config.oauthPassword)
      : undefined);
  const handler = createRequestHandler(options, config, oauth);
  const requests = new Set<Promise<void>>();
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    const task = handler.serve(request, response);
    requests.add(task);
    const remove = () => {
      requests.delete(task);
    };
    void task.then(remove, remove);
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
  async function closeListener(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    await Promise.allSettled([...requests]);
    await oauth?.close();
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    stopAccepting: handler.stopAccepting,
    close: () => {
      handler.stopAccepting();
      closing ??= closeListener();
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
  async function authorize(request: IncomingMessage): Promise<void> {
    await oauth?.ready();
    authorizeMcpRequest(
      request,
      config,
      oauth && ((header) => oauth.scopeFor(header) !== undefined),
    );
  }
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
      await authorize(request);
      if (request.url !== "/mcp") throw new McpHttpError(404, "Not found.");
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        throw new McpHttpError(
          405,
          "SSE and session deletion are not offered.",
        );
      }
      validateMcpPost(request);
      const body = await readMcpBody(request);
      if (!accepting) throw new McpHttpError(503, "MCP server is stopping.");
      await authorize(request);
      sendReply(
        response,
        await handleMcpMessage(
          body,
          visibleTools(options, request, oauth),
          options.reportError,
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

function visibleTools(
  options: ServerOptions,
  request: IncomingMessage,
  oauth?: McpOAuthHttp,
) {
  if (!options.enforceScopes) return options.tools;
  const scope = oauth?.scopeFor(request.headers.authorization ?? "") ?? "";
  const scopes = scope.split(" ");
  return options.tools
    .filter((tool) =>
      (tool.requiredScopes ?? ["carrot.read"]).every((needed) =>
        scopes.includes(needed),
      ),
    )
    .map((tool) => {
      const assertAuthorized = () => {
        const current =
          oauth?.scopeFor(request.headers.authorization ?? "")?.split(" ") ??
          [];
        if (
          !(tool.requiredScopes ?? ["carrot.read"]).every((needed) =>
            current.includes(needed),
          )
        )
          throw new McpEditError(
            "access_denied",
            "Authorization changed. Reconnect or request approval in the app.",
          );
      };
      return {
        ...tool,
        invoke: async (args: Record<string, unknown>) => {
          assertAuthorized();
          const result = await tool.invoke(args, { assertAuthorized });
          assertAuthorized();
          return result;
        },
      };
    });
}
