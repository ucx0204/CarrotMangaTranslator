import type {
  CodexAppServerModel,
  CodexAppServerTurnResult,
} from "./codexAppServerProtocol";

const CODEX_WEB_RESEARCH_FALLBACK_MODEL_IDS = ["gpt-5.5"] as const;

export type CodexWebResearchFallback = {
  model: string;
  effort: string;
};

export async function runCodexWebResearchWithFallback({
  models,
  selectedModel,
  selectedEffort,
  runTurn,
  signal,
  onFallback,
}: {
  models: readonly CodexAppServerModel[];
  selectedModel: string;
  selectedEffort: string;
  runTurn: (model: string, effort: string) => Promise<CodexAppServerTurnResult>;
  signal?: AbortSignal;
  onFallback?: (fallback: CodexWebResearchFallback) => void;
}): Promise<{ result: CodexAppServerTurnResult; warnings: string[] }> {
  let result = await runTurn(selectedModel, selectedEffort);
  if (webSearchWasUsed(result)) return { result, warnings: [] };
  const fallback = selectCodexWebResearchFallback(
    models,
    selectedModel,
    selectedEffort,
  );
  if (!fallback) throw webSearchUnavailableError(selectedModel);
  signal?.throwIfAborted();
  onFallback?.(fallback);
  result = await runTurn(fallback.model, fallback.effort);
  if (!webSearchWasUsed(result)) {
    throw webSearchUnavailableError(selectedModel, fallback.model);
  }
  return {
    result,
    warnings: [
      `선택한 Codex 모델 ${selectedModel}의 조사에서 웹 검색 호출이 확인되지 않아 ${fallback.model}로 자동 재시도했습니다.`,
    ],
  };
}

export function selectCodexWebResearchFallback(
  models: readonly CodexAppServerModel[],
  selectedModel: string,
  selectedEffort: string,
): CodexWebResearchFallback | null {
  for (const fallbackId of CODEX_WEB_RESEARCH_FALLBACK_MODEL_IDS) {
    if (fallbackId === selectedModel) continue;
    const catalogModel = models.find((model) => model.id === fallbackId);
    if (models.length > 0 && !catalogModel) continue;
    return {
      model: fallbackId,
      effort: resolveFallbackEffort(catalogModel, selectedEffort),
    };
  }
  return null;
}

function resolveFallbackEffort(
  model: CodexAppServerModel | undefined,
  selectedEffort: string,
): string {
  if (!model || model.supportedReasoningEfforts.length === 0) {
    return selectedEffort;
  }
  if (model.supportedReasoningEfforts.includes(selectedEffort)) {
    return selectedEffort;
  }
  if (model.supportedReasoningEfforts.includes(model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort;
  }
  return model.supportedReasoningEfforts[0] ?? selectedEffort;
}

function webSearchWasUsed(result: CodexAppServerTurnResult): boolean {
  return (result.webSearchCount ?? 0) >= 1;
}

function webSearchUnavailableError(
  selectedModel: string,
  fallbackModel?: string,
): Error {
  const fallbackDetail = fallbackModel
    ? ` ${fallbackModel} 자동 재시도에서도 웹 검색 호출이 확인되지 않았습니다.`
    : " 자동 재시도할 호환 모델도 현재 계정에서 사용할 수 없습니다.";
  return new Error(
    `선택한 Codex 모델 ${selectedModel}의 조사에서 웹 검색 호출이 확인되지 않았습니다.${fallbackDetail}`,
  );
}
