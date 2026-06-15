import React from "react";
import type {
  AppSettings,
  CodexReasoningEffort,
  FluxBackend,
  GemmaVramMode,
  LlamaRuntimeProfile,
  ModelProvider,
  ModelSource,
  OcrDevice,
} from "../../../shared/types";
import {
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS,
  MODEL_PRESETS,
  resolveModelPreset,
  type ModelPresetId,
} from "./settingsOptions";
import { buildSettingsFromForm } from "./settingsFormBuilder";
import {
  EngineSettingsPanel,
  HardwareSettingsPanel,
  SettingsTabs,
  SettingsValidationMessages,
  TestSettingsPanel,
} from "./SettingsModalSections";
import {
  buildTestDetail,
  formatModelTestProgressLine,
  isAmdLlamaRuntimeProfile,
  isNvidiaLlamaRuntimeProfile,
  resolveHardwareRuntimeLock,
} from "./settingsModalHelpers";
import type { SettingsTabId, TestState } from "./settingsModalTypes";
import { Button, Modal } from "./ui";
import { mangaGateway } from "../api/mangaGateway";

type SettingsModalProps = {
  initialSettings: AppSettings;
  busy: boolean;
  jobActive: boolean;
  onCancel: () => void;
  onOpenLogFolder: () => void;
  onReset: () => void;
  onSubmit: (settings: AppSettings) => void;
};

export function SettingsModal({
  initialSettings,
  busy,
  jobActive,
  onCancel,
  onOpenLogFolder,
  onReset,
  onSubmit,
}: SettingsModalProps): React.JSX.Element {
  const [modelProvider, setModelProvider] = React.useState<ModelProvider>(
    initialSettings.modelProvider,
  );
  const [modelSource, setModelSource] = React.useState<ModelSource>(
    initialSettings.gemma.modelSource,
  );
  const [selectedPreset, setSelectedPreset] = React.useState<ModelPresetId>(
    () =>
      resolveModelPreset(
        initialSettings.gemma.modelRepo,
        initialSettings.gemma.modelFile,
      ),
  );
  const [customModelRepo, setCustomModelRepo] = React.useState(
    initialSettings.gemma.modelRepo,
  );
  const [customModelFile, setCustomModelFile] = React.useState(
    initialSettings.gemma.modelFile,
  );
  const [localModelPath, setLocalModelPath] = React.useState(
    initialSettings.gemma.localModelPath ?? "",
  );
  const [localMmprojPath, setLocalMmprojPath] = React.useState(
    initialSettings.gemma.localMmprojPath ?? "",
  );
  const [customVramMode, setCustomVramMode] = React.useState<GemmaVramMode>(
    initialSettings.gemma.vramMode,
  );
  const [llamaRuntimeProfile, setLlamaRuntimeProfile] =
    React.useState<LlamaRuntimeProfile>(
      initialSettings.gemma.llamaRuntimeProfile ?? "cuda12",
    );
  const [codexModel, setCodexModel] = React.useState(
    initialSettings.codex.model,
  );
  const [codexReasoningEffort, setCodexReasoningEffort] =
    React.useState<CodexReasoningEffort>(initialSettings.codex.reasoningEffort);
  const [codexOauthPort, setCodexOauthPort] = React.useState(
    String(initialSettings.codex.oauthPort),
  );
  const [ocrDevice, setOcrDevice] = React.useState<OcrDevice>(
    initialSettings.ocr.device,
  );
  const [fluxBackend, setFluxBackend] = React.useState<FluxBackend>(
    initialSettings.inpainting?.fluxBackend ?? "cuda-native",
  );
  const [maxTokens, setMaxTokens] = React.useState(
    String(initialSettings.maxTokens),
  );
  const [activeTab, setActiveTab] = React.useState<SettingsTabId>("engine");
  const [localActionBusy, setLocalActionBusy] = React.useState(false);
  const [testState, setTestState] = React.useState<TestState>({
    status: "idle",
    message: null,
    detail: null,
  });
  const [testLogLines, setTestLogLines] = React.useState<string[]>([]);
  const modelRepoInputRef = React.useRef<HTMLInputElement | null>(null);
  const localModelInputRef = React.useRef<HTMLInputElement | null>(null);
  const testLogRef = React.useRef<HTMLDivElement | null>(null);
  const hardwareRuntimeLock = React.useMemo(
    () => resolveHardwareRuntimeLock(initialSettings),
    [initialSettings],
  );

  React.useEffect(() => {
    setModelProvider(initialSettings.modelProvider);
    setModelSource(initialSettings.gemma.modelSource);
    setSelectedPreset(
      resolveModelPreset(
        initialSettings.gemma.modelRepo,
        initialSettings.gemma.modelFile,
      ),
    );
    setCustomModelRepo(initialSettings.gemma.modelRepo);
    setCustomModelFile(initialSettings.gemma.modelFile);
    setLocalModelPath(initialSettings.gemma.localModelPath ?? "");
    setLocalMmprojPath(initialSettings.gemma.localMmprojPath ?? "");
    setCustomVramMode(initialSettings.gemma.vramMode);
    setLlamaRuntimeProfile(
      initialSettings.gemma.llamaRuntimeProfile ?? "cuda12",
    );
    setCodexModel(initialSettings.codex.model);
    setCodexReasoningEffort(initialSettings.codex.reasoningEffort);
    setCodexOauthPort(String(initialSettings.codex.oauthPort));
    setOcrDevice(initialSettings.ocr.device);
    setFluxBackend(initialSettings.inpainting?.fluxBackend ?? "cuda-native");
    setMaxTokens(String(initialSettings.maxTokens));
    setTestState({ status: "idle", message: null, detail: null });
    setTestLogLines([]);
  }, [initialSettings]);

  React.useEffect(() => {
    if (!testLogRef.current) {
      return;
    }
    testLogRef.current.scrollTop = testLogRef.current.scrollHeight;
  }, [testLogLines]);

  React.useEffect(() => {
    if (modelProvider === "openai-codex") {
      return;
    }
    if (modelSource === "local") {
      localModelInputRef.current?.focus();
      localModelInputRef.current?.select();
      return;
    }
    if (selectedPreset === "custom") {
      modelRepoInputRef.current?.focus();
      modelRepoInputRef.current?.select();
    }
  }, [modelProvider, modelSource, selectedPreset]);

  const usesAmdHardware = hardwareRuntimeLock === "amd";
  const usesNvidiaHardware = hardwareRuntimeLock === "nvidia";
  const usesAmdGemmaRuntime =
    modelProvider === "gemma" && isAmdLlamaRuntimeProfile(llamaRuntimeProfile);
  const forceOcrCpu = usesAmdHardware || usesAmdGemmaRuntime;

  React.useEffect(() => {
    if (forceOcrCpu && ocrDevice !== "cpu") {
      setOcrDevice("cpu");
    }
  }, [forceOcrCpu, ocrDevice]);

  React.useEffect(() => {
    if (usesAmdHardware && isNvidiaLlamaRuntimeProfile(llamaRuntimeProfile)) {
      const preferredProfile = isAmdLlamaRuntimeProfile(
        initialSettings.gemma.llamaRuntimeProfile ?? "rocm",
      )
        ? (initialSettings.gemma.llamaRuntimeProfile ?? "rocm")
        : "rocm";
      setLlamaRuntimeProfile(preferredProfile);
      return;
    }
    if (usesNvidiaHardware && isAmdLlamaRuntimeProfile(llamaRuntimeProfile)) {
      const preferredProfile = isNvidiaLlamaRuntimeProfile(
        initialSettings.gemma.llamaRuntimeProfile ?? "cuda12",
      )
        ? (initialSettings.gemma.llamaRuntimeProfile ?? "cuda12")
        : "cuda12";
      setLlamaRuntimeProfile(preferredProfile);
    }
  }, [
    initialSettings.gemma.llamaRuntimeProfile,
    llamaRuntimeProfile,
    usesAmdHardware,
    usesNvidiaHardware,
  ]);

  React.useEffect(() => {
    if (usesAmdHardware && fluxBackend === "cuda-native") {
      const preferredBackend =
        initialSettings.inpainting?.fluxBackend === "python-cpu"
          ? "python-cpu"
          : "zluda-native";
      setFluxBackend(preferredBackend);
      return;
    }
    if (usesNvidiaHardware && fluxBackend === "zluda-native") {
      setFluxBackend("cuda-native");
    }
  }, [
    fluxBackend,
    initialSettings.inpainting?.fluxBackend,
    usesAmdHardware,
    usesNvidiaHardware,
  ]);

  const controlsBusy =
    busy || localActionBusy || testState.status === "running";
  const activePreset =
    modelSource === "huggingface" && selectedPreset !== "custom"
      ? MODEL_PRESETS[selectedPreset]
      : null;
  const trimmedModelRepo = (activePreset?.modelRepo ?? customModelRepo).trim();
  const trimmedModelFile = (activePreset?.modelFile ?? customModelFile).trim();
  const trimmedMmprojRepo = activePreset?.mmprojRepo;
  const trimmedMmprojFile = activePreset?.mmprojFile;
  const selectedVramMode = activePreset?.vramMode ?? customVramMode;
  const trimmedLocalModelPath = localModelPath.trim();
  const trimmedLocalMmprojPath = localMmprojPath.trim();
  const trimmedCodexModel = codexModel.trim();
  const parsedCodexOauthPort = Number(codexOauthPort);
  const parsedMaxTokens = Number(maxTokens);
  const codexOauthPortValid =
    Number.isInteger(parsedCodexOauthPort) &&
    parsedCodexOauthPort >= 1 &&
    parsedCodexOauthPort <= 65535;
  const maxTokensValid =
    Number.isInteger(parsedMaxTokens) &&
    parsedMaxTokens >= MIN_MAX_TOKENS &&
    parsedMaxTokens <= MAX_MAX_TOKENS;
  const gemmaSettingsReady =
    modelSource === "local"
      ? Boolean(trimmedLocalModelPath)
      : Boolean(trimmedModelRepo && trimmedModelFile);
  const canSubmit = Boolean(
    maxTokensValid &&
    (modelProvider === "openai-codex"
      ? trimmedCodexModel && codexOauthPortValid
      : gemmaSettingsReady),
  );
  const isLlamaRuntimeOptionDisabled = React.useCallback(
    (profile: LlamaRuntimeProfile) =>
      controlsBusy ||
      (usesAmdHardware && isNvidiaLlamaRuntimeProfile(profile)) ||
      (usesNvidiaHardware && isAmdLlamaRuntimeProfile(profile)),
    [controlsBusy, usesAmdHardware, usesNvidiaHardware],
  );
  const isFluxBackendOptionDisabled = React.useCallback(
    (backend: FluxBackend) =>
      controlsBusy ||
      (usesAmdHardware && backend === "cuda-native") ||
      (usesNvidiaHardware && backend === "zluda-native"),
    [controlsBusy, usesAmdHardware, usesNvidiaHardware],
  );

  const buildSettings = React.useCallback((): AppSettings | null => {
    if (!maxTokensValid) {
      return null;
    }

    if (
      modelProvider === "openai-codex" &&
      (!trimmedCodexModel || !codexOauthPortValid)
    ) {
      return null;
    }

    return buildSettingsFromForm({
      initialSettings,
      modelProvider,
      modelSource,
      modelRepo: trimmedModelRepo,
      modelFile: trimmedModelFile,
      mmprojRepo: trimmedMmprojRepo,
      mmprojFile: trimmedMmprojFile,
      localModelPath: trimmedLocalModelPath,
      localMmprojPath: trimmedLocalMmprojPath,
      vramMode: selectedVramMode,
      llamaRuntimeProfile,
      codexModel: trimmedCodexModel,
      codexReasoningEffort,
      codexOauthPort: codexOauthPortValid
        ? parsedCodexOauthPort
        : initialSettings.codex.oauthPort,
      ocrDevice,
      fluxBackend,
      maxTokens: parsedMaxTokens,
    });
  }, [
    modelProvider,
    codexOauthPortValid,
    initialSettings,
    modelSource,
    trimmedModelRepo,
    trimmedModelFile,
    trimmedMmprojRepo,
    trimmedMmprojFile,
    trimmedLocalModelPath,
    trimmedLocalMmprojPath,
    trimmedCodexModel,
    parsedCodexOauthPort,
    parsedMaxTokens,
    selectedVramMode,
    llamaRuntimeProfile,
    codexReasoningEffort,
    ocrDevice,
    fluxBackend,
    maxTokensValid,
  ]);

  const clearTestState = React.useCallback(() => {
    setTestState({ status: "idle", message: null, detail: null });
    setTestLogLines([]);
  }, []);

  const appendTestLogLine = React.useCallback((line: string) => {
    const normalized = line.trim();
    if (!normalized) {
      return;
    }
    setTestLogLines((current) => {
      if (current[current.length - 1] === normalized) {
        return current;
      }
      return [...current, normalized].slice(-180);
    });
  }, []);

  const submit = React.useCallback(() => {
    const nextSettings = buildSettings();
    if (!nextSettings || !canSubmit) {
      return;
    }
    onSubmit(nextSettings);
  }, [buildSettings, canSubmit, onSubmit]);

  const pickLocalModelFile = React.useCallback(async () => {
    setLocalActionBusy(true);
    try {
      const picked = await mangaGateway.pickLocalModelFile();
      if (!picked) {
        return;
      }
      clearTestState();
      setLocalModelPath(picked.modelPath);
      if (picked.detectedMmprojPath) {
        setLocalMmprojPath(picked.detectedMmprojPath);
      }
    } finally {
      setLocalActionBusy(false);
    }
  }, [clearTestState]);

  const pickLocalMmprojFile = React.useCallback(async () => {
    setLocalActionBusy(true);
    try {
      const picked = await mangaGateway.pickLocalMmprojFile();
      if (!picked) {
        return;
      }
      clearTestState();
      setLocalMmprojPath(picked);
    } finally {
      setLocalActionBusy(false);
    }
  }, [clearTestState]);

  const runModelTest = React.useCallback(async () => {
    const nextSettings = buildSettings();
    if (!nextSettings || !canSubmit || jobActive) {
      return;
    }

    const testId = `settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setTestLogLines(["Paddle OCR과 번역 엔진 확인을 시작합니다."]);
    setTestState({
      status: "running",
      message:
        "OCR, 모델 런타임, 간단한 텍스트 응답을 차례대로 확인하는 중입니다...",
      detail:
        modelProvider === "gemma"
          ? "Paddle OCR과 Gemma 실행 런타임 준비 로그를 함께 표시합니다."
          : "Paddle OCR과 Codex 엔드포인트 준비 상태를 함께 확인합니다.",
    });
    const unsubscribe = mangaGateway.onModelTestEvent((event) => {
      if (event.id !== testId) {
        return;
      }
      appendTestLogLine(formatModelTestProgressLine(event));
      setTestState((current) =>
        current.status === "running"
          ? {
              status: "running",
              message: event.progressText,
              detail: event.detail ?? current.detail,
            }
          : current,
      );
    });
    try {
      const result = await mangaGateway.testModelSettings(nextSettings, testId);
      appendTestLogLine(
        result.ok
          ? "Paddle OCR과 번역 엔진 확인이 완료되었습니다."
          : "Paddle OCR과 번역 엔진 확인이 실패했습니다.",
      );
      setTestState({
        status: result.ok ? "success" : "error",
        message: result.message,
        detail: buildTestDetail(
          result.resolvedModelPath,
          result.resolvedMmprojPath,
          result.resolvedEndpoint,
        ),
      });
    } catch (error) {
      appendTestLogLine(
        "Paddle OCR과 번역 엔진 확인 요청 중 오류가 발생했습니다.",
      );
      setTestState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        detail: null,
      });
    } finally {
      unsubscribe();
    }
  }, [appendTestLogLine, buildSettings, canSubmit, jobActive, modelProvider]);

  return (
    <Modal
      width="min(720px, 100%)"
      ariaLabel="설정"
      title="설정"
      onClose={onCancel}
      closeDisabled={controlsBusy}
      footer={
        <>
          <Button
            variant="ghost"
            style={{ marginRight: "auto" }}
            onClick={onOpenLogFolder}
            disabled={controlsBusy}
          >
            로그 폴더 열기
          </Button>
          <Button onClick={onReset} disabled={controlsBusy}>
            기본값 복원
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={controlsBusy}>
            취소
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={controlsBusy || !canSubmit}
          >
            저장
          </Button>
        </>
      }
    >
      <div className="settings-layout">
        <SettingsTabs activeTab={activeTab} onChange={setActiveTab} />
        <div
          className="settings-tabpanel modal-section"
          role="tabpanel"
          id={`settings-panel-${activeTab}`}
          aria-labelledby={`settings-tab-${activeTab}`}
        >
          <p className="muted-line modal-note">
            다음 번 번역 실행부터 적용됩니다.
          </p>

          {activeTab === "engine" ? (
            <EngineSettingsPanel
              clearTestState={clearTestState}
              codexModel={codexModel}
              codexOauthPort={codexOauthPort}
              codexReasoningEffort={codexReasoningEffort}
              controlsBusy={controlsBusy}
              customModelFile={customModelFile}
              customModelRepo={customModelRepo}
              isLlamaRuntimeOptionDisabled={isLlamaRuntimeOptionDisabled}
              llamaRuntimeProfile={llamaRuntimeProfile}
              localMmprojPath={localMmprojPath}
              localModelInputRef={localModelInputRef}
              localModelPath={localModelPath}
              maxTokens={maxTokens}
              modelProvider={modelProvider}
              modelRepoInputRef={modelRepoInputRef}
              modelSource={modelSource}
              pickLocalMmprojFile={pickLocalMmprojFile}
              pickLocalModelFile={pickLocalModelFile}
              selectedPreset={selectedPreset}
              setCodexModel={setCodexModel}
              setCodexOauthPort={setCodexOauthPort}
              setCodexReasoningEffort={setCodexReasoningEffort}
              setCustomModelFile={setCustomModelFile}
              setCustomModelRepo={setCustomModelRepo}
              setCustomVramMode={setCustomVramMode}
              setLlamaRuntimeProfile={setLlamaRuntimeProfile}
              setLocalMmprojPath={setLocalMmprojPath}
              setLocalModelPath={setLocalModelPath}
              setMaxTokens={setMaxTokens}
              setModelProvider={setModelProvider}
              setModelSource={setModelSource}
              setSelectedPreset={setSelectedPreset}
              submit={submit}
              usesAmdHardware={usesAmdHardware}
              usesNvidiaHardware={usesNvidiaHardware}
            />
          ) : null}

          {activeTab === "hardware" ? (
            <HardwareSettingsPanel
              clearTestState={clearTestState}
              controlsBusy={controlsBusy}
              fluxBackend={fluxBackend}
              forceOcrCpu={forceOcrCpu}
              isFluxBackendOptionDisabled={isFluxBackendOptionDisabled}
              ocrDevice={ocrDevice}
              setFluxBackend={setFluxBackend}
              setOcrDevice={setOcrDevice}
              usesAmdHardware={usesAmdHardware}
              usesNvidiaHardware={usesNvidiaHardware}
            />
          ) : null}

          {activeTab === "test" ? (
            <TestSettingsPanel
              canSubmit={canSubmit}
              controlsBusy={controlsBusy}
              jobActive={jobActive}
              runModelTest={runModelTest}
              testLogLines={testLogLines}
              testLogRef={testLogRef}
              testState={testState}
            />
          ) : null}

          <SettingsValidationMessages
            codexOauthPortValid={codexOauthPortValid}
            maxTokensValid={maxTokensValid}
            modelProvider={modelProvider}
          />
        </div>
      </div>
    </Modal>
  );
}
