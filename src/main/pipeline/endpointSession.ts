import type { TranslationOptions } from "../appSettings";
import type { ModelEndpointHandle, PipelineOptions } from "./types";
import { readNumberEnv } from "./options";
import {
  emitEndpointReady,
  emitEndpointStarting,
  type ProgressContext,
} from "./progressEvents";
import type { TranslationRuntimePort } from "./translationRuntimePort";

export type AnalysisEndpointSession = {
  server: ModelEndpointHandle;
  maxAttempts: number;
  disposeEndpointSession: () => Promise<void>;
};

export async function startAnalysisEndpointSession({
  apiSelected,
  baseOptions,
  codexSelected,
  formatGemmaVramMode,
  localModelSelected,
  modelCached,
  onCleanupReady,
  progressContext,
  runtime,
}: {
  baseOptions: TranslationOptions;
  apiSelected: boolean;
  codexSelected: boolean;
  formatGemmaVramMode: (mode: TranslationOptions["gemmaVramMode"]) => string;
  localModelSelected: boolean;
  modelCached: boolean;
  onCleanupReady?: PipelineOptions["onCleanupReady"];
  progressContext: ProgressContext;
  runtime: TranslationRuntimePort;
}): Promise<AnalysisEndpointSession> {
  emitEndpointStarting(progressContext, {
    baseOptions,
    apiSelected,
    codexSelected,
    formatGemmaVramMode,
    localModelSelected,
    modelCached,
  });

  const endpointSession = await runtime.startEndpointSession(baseOptions);
  const server = endpointSession.handle;
  let endpointDisposed = false;
  const disposeEndpointSession = async () => {
    if (endpointDisposed) {
      return;
    }
    endpointDisposed = true;
    await endpointSession.dispose();
  };
  onCleanupReady?.(disposeEndpointSession);

  emitEndpointReady(progressContext, {
    server,
    apiSelected,
    baseOptions,
    codexSelected,
  });

  return {
    server,
    maxAttempts: Math.max(1, readNumberEnv("MANGA_TRANSLATOR_PAGE_RETRIES", 5)),
    disposeEndpointSession,
  };
}
