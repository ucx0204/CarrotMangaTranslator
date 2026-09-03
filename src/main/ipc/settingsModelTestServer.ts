import { throwIfAborted } from "../abortSignal";
import type { TranslationOptions } from "../appSettings";
import {
  startCodexAppServerEndpoint,
  stopCodexAppServerEndpoint,
  type CodexAppServerEndpoint,
} from "../codexAppServerEndpoint";
import {
  createOpenAICompatibleApiEndpoint,
  isOpenAICompatibleApiEndpoint,
  stopOpenAICompatibleApiEndpoint,
  type OpenAICompatibleApiEndpoint,
} from "../openaiApiEndpoint";
import {
  isCodexAppServerEndpoint,
  type SimplePageRuntime,
} from "../simplePageRuntime";
import type { ModelLifecycleWarning } from "../ollamaModelLifecycle";
import { tMain } from "./localization";
import type { SendModelTestProgress } from "./settingsModelTestProgress";
import { reserveFreePort } from "./settingsModelTestPort";

const MODEL_TEST_PORT_ATTEMPTS = 4;

export type ModelTestServer =
  | Awaited<ReturnType<SimplePageRuntime["startServer"]>>
  | CodexAppServerEndpoint
  | OpenAICompatibleApiEndpoint;

export type ModelTestEndpointRuntime = {
  startCodexAppServerEndpoint: typeof startCodexAppServerEndpoint;
  stopCodexAppServerEndpoint: typeof stopCodexAppServerEndpoint;
};

export const productionModelTestEndpointRuntime: ModelTestEndpointRuntime = {
  startCodexAppServerEndpoint,
  stopCodexAppServerEndpoint,
};

export async function startModelTestServerWithRetry(
  runtime: SimplePageRuntime,
  initialOptions: TranslationOptions,
  sendProgress: SendModelTestProgress,
  endpointRuntime: ModelTestEndpointRuntime,
): Promise<{ server: ModelTestServer; options: TranslationOptions }> {
  throwIfAborted(initialOptions.abortSignal ?? undefined);
  if (initialOptions.modelProvider === "openai-api") {
    return {
      server: createOpenAICompatibleApiEndpoint(initialOptions),
      options: initialOptions,
    };
  }
  if (initialOptions.modelProvider === "openai-codex") {
    return {
      server: await endpointRuntime.startCodexAppServerEndpoint(initialOptions),
      options: initialOptions,
    };
  }

  let options = initialOptions;
  for (let attempt = 1; attempt <= MODEL_TEST_PORT_ATTEMPTS; attempt += 1) {
    try {
      throwIfAborted(options.abortSignal ?? undefined);
      return { server: await runtime.startServer(options), options };
    } catch (error) {
      if (!isPortBindError(error) || attempt >= MODEL_TEST_PORT_ATTEMPTS) {
        throw error;
      }
      const nextPort = await reserveFreePort(options.abortSignal ?? undefined);
      throwIfAborted(options.abortSignal ?? undefined);
      options = { ...options, port: nextPort };
      sendProgress({
        phase: "booting",
        progressText: tMain("modelTest.portRetry"),
        detail: tMain("modelTest.portRetryDetail", { port: nextPort }),
        installLogLine: tMain("modelTest.portRetryLog", { port: nextPort }),
      });
    }
  }
  throw new Error(tMain("modelTest.portUnavailable"));
}

export async function stopModelTestServer(
  runtime: SimplePageRuntime,
  server: ModelTestServer | null,
  endpointRuntime: ModelTestEndpointRuntime,
  options: TranslationOptions,
  onWarning: ModelLifecycleWarning,
): Promise<void> {
  if (isCodexAppServerEndpoint(server)) {
    await endpointRuntime.stopCodexAppServerEndpoint(server);
    return;
  }
  if (isOpenAICompatibleApiEndpoint(server)) {
    await stopOpenAICompatibleApiEndpoint(options, onWarning);
    return;
  }
  await runtime.stopServer(server);
}

export function formatModelTestError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const details = [
    error.message,
    "recentStderr" in error &&
    typeof error.recentStderr === "string" &&
    error.recentStderr.trim()
      ? error.recentStderr.trim()
      : null,
    "rawTextPreview" in error &&
    typeof error.rawTextPreview === "string" &&
    error.rawTextPreview.trim()
      ? error.rawTextPreview.trim()
      : null,
  ].filter(Boolean);
  return details.join("\n\n");
}

function isPortBindError(error: unknown): boolean {
  const text = formatModelTestError(error).toLowerCase();
  return (
    text.includes("eaddrinuse") ||
    text.includes("address already in use") ||
    text.includes("bind failed") ||
    text.includes("failed to bind") ||
    text.includes("only one usage of each socket address")
  );
}
