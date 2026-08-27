import { app } from "electron";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { TranslationOptions } from "./appSettings";
import { getAppPaths, type AppPaths } from "./appPaths";
import { CodexAppServerClient } from "./codexAppServerClient";
import {
  asRecord,
  type CodexAppServerModel,
  type JsonRecord,
} from "./codexAppServerProtocol";
import {
  codexEndpointRequestError,
  MAX_CODEX_RESPONSES_REQUEST_BYTES,
  parseCodexResponsesRequest,
} from "./codexAppServerResponsesRequest";
import { logInfo, logWarn } from "./logger";

export type CodexAppServerEndpoint = {
  baseUrl: string;
  child: ChildProcessWithoutNullStreams;
  startedByScript: true;
  provider: "openai-codex";
  appServer: CodexAppServerEndpointClient;
  httpServer: Server;
  models: CodexAppServerModel[];
  closed?: boolean;
};

export type CodexAppServerEndpointClient = Pick<
  CodexAppServerClient,
  | "version"
  | "process"
  | "readAccount"
  | "listModels"
  | "runEphemeralTurn"
  | "dispose"
>;

export type CodexAppServerEndpointRuntime = {
  getPaths: () => AppPaths;
  appVersion: () => string;
  startClient: (options: {
    paths: AppPaths;
    appVersion: string;
  }) => Promise<CodexAppServerEndpointClient>;
};

const productionEndpointRuntime: CodexAppServerEndpointRuntime = {
  getPaths: getAppPaths,
  appVersion: () => app.getVersion(),
  startClient: CodexAppServerClient.start,
};

export async function startCodexAppServerEndpoint(
  options: TranslationOptions,
  runtime: CodexAppServerEndpointRuntime = productionEndpointRuntime,
): Promise<CodexAppServerEndpoint> {
  const paths = runtime.getPaths();
  const appServer = await runtime.startClient({
    paths,
    appVersion: runtime.appVersion(),
  });
  let httpServer: Server | null = null;
  try {
    const account = await appServer.readAccount(false);
    if (account.requiresOpenaiAuth && !account.account) {
      throw new Error(
        "OpenAI Codex 로그인이 필요합니다. 설정 > 번역 엔진에서 ChatGPT로 로그인해 주세요.",
      );
    }
    const models = await appServer.listModels();
    if (
      models.length > 0 &&
      !models.some((model) => model.id === options.codexModel)
    ) {
      logWarn("Selected Codex model was not advertised by App Server", {
        selectedModel: options.codexModel,
        availableModels: models.map((model) => model.id),
      });
    }
    httpServer = createServer((request, response) => {
      void handleEndpointRequest({
        request,
        response,
        appServer,
        models,
        workspaceDir:
          paths.codexWorkspaceDir ?? join(paths.dataRoot, ".codex-workspace"),
      });
    });
    await listenOnLoopback(httpServer);
    const address = httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    logInfo("Official Codex App Server endpoint ready", {
      label: options.label,
      baseUrl,
      model: options.codexModel,
      reasoningEffort: options.codexReasoningEffort,
      codexVersion: appServer.version,
    });
    return {
      baseUrl,
      child: appServer.process,
      startedByScript: true,
      provider: "openai-codex",
      appServer,
      httpServer,
      models,
    };
  } catch (error) {
    if (httpServer) {
      await closeHttpServer(httpServer).catch((_closeError) => {
        // error-policy-allow: startup cleanup must preserve the primary App Server failure.
      });
    }
    await appServer.dispose();
    throw error;
  }
}

export async function stopCodexAppServerEndpoint(
  endpoint: CodexAppServerEndpoint | null | undefined,
): Promise<void> {
  if (!endpoint || endpoint.closed) return;
  endpoint.closed = true;
  const results = await Promise.allSettled([
    closeHttpServer(endpoint.httpServer),
    endpoint.appServer.dispose(),
  ]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Codex App Server 정리에 실패했습니다.");
  }
}

async function handleEndpointRequest({
  request,
  response,
  appServer,
  models,
  workspaceDir,
}: {
  request: IncomingMessage;
  response: ServerResponse;
  appServer: CodexAppServerEndpointClient;
  models: CodexAppServerModel[];
  workspaceDir: string;
}): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      sendJson(response, 200, buildModelsResponse(models));
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/v1/responses") {
      sendJson(response, 404, { error: { message: "Not found" } });
      return;
    }
    const abortController = bindRequestAbort(request, response);
    const body = parseCodexResponsesRequest(
      await readJsonRequestBody(request, abortController.signal),
    );
    const result = await appServer.runEphemeralTurn({
      ...body,
      cwd: workspaceDir,
      signal: abortController.signal,
    });
    if (abortController.signal.aborted || response.destroyed) return;
    sendResponsesSse(response, body.model, result);
  } catch (error) {
    if (response.destroyed || isAbortError(error)) return;
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, statusForEndpointError(error), {
      error: {
        message,
        type: "codex_app_server_error",
      },
    });
  }
}

async function readJsonRequestBody(
  request: IncomingMessage,
  signal: AbortSignal,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_CODEX_RESPONSES_REQUEST_BYTES) {
      const error = codexEndpointRequestError("Codex 요청 본문이 너무 큽니다.");
      Object.assign(error, { httpStatus: 413 });
      throw error;
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    throw codexEndpointRequestError(
      "Codex 요청 JSON을 읽지 못했습니다.",
      error,
    );
  }
}

function sendResponsesSse(
  response: ServerResponse,
  model: string,
  result: {
    text: string;
    turnId: string;
    itemId: string | null;
  },
): void {
  const responseId = `resp_${result.turnId}`;
  const outputItem = {
    id: result.itemId ?? `msg_${result.turnId}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: result.text, annotations: [] }],
  };
  const completed = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output: [outputItem],
    output_text: result.text,
  };
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "close",
  });
  response.end(
    [
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: result.text })}`,
      "",
      "event: response.completed",
      `data: ${JSON.stringify({ type: "response.completed", response: completed })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
  );
}

function buildModelsResponse(models: CodexAppServerModel[]): JsonRecord {
  return {
    object: "list",
    data: models.map((model) => ({
      id: model.id,
      object: "model",
      owned_by: "openai",
    })),
  };
}

function bindRequestAbort(
  request: IncomingMessage,
  response: ServerResponse,
): AbortController {
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  return controller;
}

function listenOnLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: JsonRecord,
): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function statusForEndpointError(error: unknown): number {
  const candidate = asRecord(error);
  if (typeof candidate?.httpStatus === "number") return candidate.httpStatus;
  return 502;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
