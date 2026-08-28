// @vitest-environment jsdom

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { InternetResearchSettingsPanel } from "../src/renderer/src/components/settingsModal/InternetResearchSettingsPanel";
import type { EngineSettingsPanelProps } from "../src/renderer/src/components/settingsModal/EngineSettingsPanelTypes";
import { SETTINGS_SECRET_PRESERVE_SENTINEL } from "../src/shared/settingsSecrets";
import type { CodexReasoningEffort } from "../src/shared/settingsTypes";
import type {
  ResearchGemmaPreset,
  TavilyAnalysisProvider,
} from "../src/shared/internetResearchTypes";

const signedOut = {
  authenticated: false,
  accountKind: null,
  email: null,
  planType: null,
  requiresOpenaiAuth: true,
  appServerVersion: "0.150.1",
  models: [],
} as const;

const signedIn = {
  authenticated: true,
  accountKind: "chatgpt",
  email: "researcher@example.com",
  planType: "plus",
  requiresOpenaiAuth: true,
  appServerVersion: "0.150.1",
  models: [
    {
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      supportedReasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
      isDefault: true,
    },
  ],
} as const;

const getCodexAccount = vi.fn();
const loginCodexAccount = vi.fn();
const getTavilyUsage = vi.fn();
const openResearchSource = vi.fn();

function createBaseEngineProps(): EngineSettingsPanelProps {
  const noop = vi.fn();
  return {
    apiBaseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    apiKeyCount: 1,
    apiVertexAuthMode: "access-token",
    apiVertexServiceAccountPath: "",
    apiKeyMaxAttempts: "5",
    apiRetryDelaySeconds: "1",
    apiModel: "translation-model",
    apiTemperature: "0.2",
    apiTopP: "0.95",
    apiTopK: "",
    apiReasoningEffort: "",
    apiExtraBodyJson: "",
    apiCustomHeadersJson: "",
    clearTestState: noop,
    codexModel: "gpt-5.6-sol",
    codexReasoningEffort: "medium",
    contextTokens: "65536",
    controlsBusy: false,
    detectedGpuName: "NVIDIA GeForce RTX 3060",
    gpuMemoryMb: 12288,
    customModelFile: "custom.gguf",
    customModelRepo: "owner/model",
    gemmaFitTargetMb: 512,
    gemmaMmprojOffload: true,
    isLlamaRuntimeOptionDisabled: () => false,
    llamaRuntimeProfile: "cuda12",
    allowUnsafeUnifiedMemory: false,
    unifiedMemoryMb: null,
    localMmprojPath: "",
    localModelInputRef: React.createRef<HTMLInputElement>(),
    localModelPath: "",
    maxTokens: "32768",
    modelProvider: "gemma",
    modelRepoInputRef: React.createRef<HTMLInputElement>(),
    modelSource: "huggingface",
    pickLocalMmprojFile: async () => undefined,
    pickLocalModelFile: async () => undefined,
    selectedPreset: "minimum12b",
    setCodexModel: noop,
    setCodexReasoningEffort: noop,
    setContextTokens: noop,
    setCustomModelFile: noop,
    setCustomModelRepo: noop,
    setCustomVramMode: noop,
    setGemmaFitTargetMb: noop,
    setGemmaMmprojOffload: noop,
    setLlamaRuntimeProfile: noop,
    setAllowUnsafeUnifiedMemory: noop,
    setLocalMmprojPath: noop,
    setLocalModelPath: noop,
    setMaxTokens: noop,
    setModelProvider: noop,
    setModelSource: noop,
    setSourceLanguage: noop,
    setTargetLanguage: noop,
    sourceLanguage: "ja",
    targetLanguage: "ko",
    setSelectedPreset: noop,
    setApiBaseUrl: noop,
    setApiCustomHeadersJson: noop,
    setApiExtraBodyJson: noop,
    setApiKey: noop,
    setApiVertexAuthMode: noop,
    setApiVertexServiceAccountPath: noop,
    setApiKeyMaxAttempts: noop,
    setApiRetryDelaySeconds: noop,
    setApiModel: noop,
    setApiReasoningEffort: noop,
    setApiTemperature: noop,
    setApiTopK: noop,
    setApiTopP: noop,
    submit: noop,
    usesAmdHardware: false,
    usesAppleHardware: false,
    usesNvidiaHardware: true,
    usesRtx50Hardware: false,
  };
}

beforeEach(() => {
  getCodexAccount.mockReset().mockResolvedValue(signedOut);
  loginCodexAccount.mockReset().mockResolvedValue(signedIn);
  getTavilyUsage.mockReset().mockResolvedValue({
    configured: true,
    key: { used: 120, limit: 500, remaining: 380, searchUsed: 100 },
    account: {
      plan: "Free",
      used: 120,
      limit: 500,
      remaining: 380,
      paygoUsed: 0,
      paygoLimit: 0,
    },
    fetchedAt: "2026-08-28T00:00:00.000Z",
  });
  openResearchSource.mockReset().mockResolvedValue({
    opened: true,
    url: "https://www.tavily.com/",
  });
  window.mangaApi = createTestMangaGatewayStub({
    getCodexAccount,
    loginCodexAccount,
    getTavilyUsage,
    openResearchSource,
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "mangaApi");
});

describe("InternetResearchSettingsPanel", () => {
  it("shows independent Gemma defaults and authoritative Tavily usage", async () => {
    render(<Harness initialProvider="gemma" />);

    expect(
      screen
        .getByRole("radio", { name: /Gemma 로컬/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByRole("group", { name: "모델 프리셋" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "모델 계열" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "추론 강도" })).toBeTruthy();
    expect(
      (screen.getAllByLabelText("최대 출력 토큰")[0] as HTMLInputElement).value,
    ).toBe("32768");
    expect(
      (screen.getAllByLabelText("컨텍스트 길이")[0] as HTMLInputElement).value,
    ).toBe("65536");
    expect(
      screen.getByText("최대 출력 32,768 · 컨텍스트 길이 65,536"),
    ).toBeTruthy();
    expect(screen.queryByText(/작품 컨텍스트/)).toBeNull();
    expect(
      (screen.getByLabelText("조사당 최대 크레딧") as HTMLInputElement).value,
    ).toBe("10");
    expect(
      (screen.getByLabelText("조사당 최대 크레딧") as HTMLInputElement).min,
    ).toBe("5");
    fireEvent.click(
      screen.getByRole("button", { name: "Tavily에서 API 키 발급" }),
    );
    expect(openResearchSource).toHaveBeenCalledWith("https://www.tavily.com/");
    await screen.findByText("사용 120 / 500 · 남음 380");
    expect(getTavilyUsage).toHaveBeenCalledWith({
      apiKey: SETTINGS_SECRET_PRESERVE_SENTINEL,
      force: false,
    });

    fireEvent.click(screen.getByRole("combobox", { name: "추론 강도" }));
    fireEvent.click(screen.getByRole("option", { name: "높음" }));
    expect(screen.getByText("더 많은 추론으로 품질을 높입니다.")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: /API/ }));
    expect(
      screen.getByRole("radio", { name: /API/ }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: /Gemma 로컬/ }));

    fireEvent.change(screen.getByLabelText("Tavily API 키"), {
      target: { value: "tvly-updated" },
    });
    fireEvent.click(screen.getByRole("button", { name: "연결 확인" }));
    await waitFor(() =>
      expect(getTavilyUsage).toHaveBeenCalledWith({
        apiKey: "tvly-updated",
        force: true,
      }),
    );
  });

  it("provides API credentials and a research-only model for Tavily analysis", () => {
    render(<Harness initialProvider="api" />);

    expect(
      screen.getByRole("radio", { name: /API/ }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByDisplayValue("https://api.openai.com/v1")).toBeTruthy();
    expect(screen.getByDisplayValue("research-model")).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "API 제공자 빠른 설정" }),
    ).toBeTruthy();
    expect(screen.getByText("고급 API 설정")).toBeTruthy();
  });

  it("hides the Codex catalog before login and shows the server catalog after login", async () => {
    render(<Harness initialProvider="gemma" />);

    await screen.findByText("로그인되지 않음");
    expect(screen.queryByRole("combobox", { name: "Codex 모델" })).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "Codex 추론 강도" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "ChatGPT로 로그인" }));

    await screen.findByText("researcher@example.com");
    expect(screen.getByRole("combobox", { name: "Codex 모델" })).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Codex 추론 강도" }),
    ).toBeTruthy();
    await waitFor(() => expect(loginCodexAccount).toHaveBeenCalledOnce());
  });

  it("shows independent Codex research limits without a recommendation card", () => {
    render(<Harness initialProvider="gemma" />);

    const maxOutputFields = screen.getAllByLabelText("최대 출력 토큰");
    const contextFields = screen.getAllByLabelText("컨텍스트 길이");
    expect((maxOutputFields.at(-1) as HTMLInputElement).value).toBe("32768");
    expect((contextFields.at(-1) as HTMLInputElement).value).toBe("262144");
    expect(screen.queryByText(/GPT-5\.6-Sol 권장값/)).toBeNull();
  });

  it.each([
    ["401 unauthorized", "Tavily API 키가 올바르지 않습니다."],
    [
      "429 too many requests",
      "Tavily 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
    ],
    ["invalid response JSON 객체", "Tavily 사용량 응답을 읽지 못했습니다."],
    [
      "network timeout",
      "Tavily 서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.",
    ],
    [
      "unexpected failure",
      "Tavily 연결을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    ],
  ])("shows a specific Tavily usage error for %s", async (failure, message) => {
    getTavilyUsage.mockRejectedValueOnce(new Error(failure));
    render(<Harness initialProvider="gemma" />);
    expect(await screen.findByText(message)).toBeTruthy();
  });
});

function Harness({
  initialProvider,
}: {
  initialProvider: TavilyAnalysisProvider;
}) {
  const [provider, setProvider] = React.useState(initialProvider);
  const [gemmaPreset, setGemmaPreset] =
    React.useState<ResearchGemmaPreset>("minimum12b");
  const [gemmaReasoning, setGemmaReasoning] = React.useState<
    "none" | "low" | "medium" | "high"
  >("medium");
  const [gemmaMaxOutput, setGemmaMaxOutput] = React.useState("32768");
  const [gemmaContext, setGemmaContext] = React.useState("65536");
  const [researchApiModel, setResearchApiModel] =
    React.useState("research-model");
  const [apiMaxOutput, setApiMaxOutput] = React.useState("32768");
  const [apiContext, setApiContext] = React.useState("65536");
  const [codexModel, setCodexModel] = React.useState("gpt-5.6-sol");
  const [effort, setEffort] = React.useState<CodexReasoningEffort>("medium");
  const [codexMaxOutput, setCodexMaxOutput] = React.useState("32768");
  const [codexContext, setCodexContext] = React.useState("262144");
  const [tavilyApiKey, setTavilyApiKey] = React.useState(
    SETTINGS_SECRET_PRESERVE_SENTINEL,
  );
  const [credits, setCredits] = React.useState("10");
  const [apiBaseUrl, setApiBaseUrl] = React.useState(
    "https://api.openai.com/v1",
  );
  const [apiKey, setApiKey] = React.useState("sk-test");
  const [vertexAuthMode, setVertexAuthMode] = React.useState<
    "access-token" | "service-account"
  >("access-token");
  const [vertexPath, setVertexPath] = React.useState("");
  const [keyAttempts, setKeyAttempts] = React.useState("5");
  const [retryDelay, setRetryDelay] = React.useState("1");
  return (
    <InternetResearchSettingsPanel
      {...createBaseEngineProps()}
      controlsBusy={false}
      clearTestState={vi.fn()}
      submit={vi.fn()}
      apiBaseUrl={apiBaseUrl}
      apiKey={apiKey}
      apiVertexAuthMode={vertexAuthMode}
      apiVertexServiceAccountPath={vertexPath}
      apiKeyMaxAttempts={keyAttempts}
      apiRetryDelaySeconds={retryDelay}
      setApiBaseUrl={setApiBaseUrl}
      setApiKey={setApiKey}
      setApiVertexAuthMode={setVertexAuthMode}
      setApiVertexServiceAccountPath={setVertexPath}
      setApiKeyMaxAttempts={setKeyAttempts}
      setApiRetryDelaySeconds={setRetryDelay}
      researchTavilyAnalysisProvider={provider}
      researchGemmaPreset={gemmaPreset}
      researchGemmaReasoningEffort={gemmaReasoning}
      researchGemmaMaxOutputTokens={gemmaMaxOutput}
      researchGemmaContextTokens={gemmaContext}
      researchApiModel={researchApiModel}
      researchApiMaxOutputTokens={apiMaxOutput}
      researchApiContextTokens={apiContext}
      researchCodexModel={codexModel}
      researchCodexReasoningEffort={effort}
      researchCodexMaxOutputTokens={codexMaxOutput}
      researchCodexContextTokens={codexContext}
      tavilyApiKey={tavilyApiKey}
      tavilyMaxCreditsPerRun={credits}
      setResearchTavilyAnalysisProvider={setProvider}
      setResearchGemmaPreset={setGemmaPreset}
      setResearchGemmaReasoningEffort={setGemmaReasoning}
      setResearchGemmaMaxOutputTokens={setGemmaMaxOutput}
      setResearchGemmaContextTokens={setGemmaContext}
      setResearchApiModel={setResearchApiModel}
      setResearchApiMaxOutputTokens={setApiMaxOutput}
      setResearchApiContextTokens={setApiContext}
      setResearchCodexModel={setCodexModel}
      setResearchCodexReasoningEffort={setEffort}
      setResearchCodexMaxOutputTokens={setCodexMaxOutput}
      setResearchCodexContextTokens={setCodexContext}
      setTavilyApiKey={setTavilyApiKey}
      setTavilyMaxCreditsPerRun={setCredits}
    />
  );
}
