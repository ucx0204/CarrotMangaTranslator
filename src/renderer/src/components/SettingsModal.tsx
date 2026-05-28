import React from "react";
import type {
  AppSettings,
  CodexReasoningEffort,
  GemmaVramMode,
  ModelTestProgressEvent,
  ModelProvider,
  ModelSource,
  OcrDevice
} from "../../../shared/types";

const MAX_GPU_LAYERS = 30;
const MIN_MAX_TOKENS = 300;
const MAX_MAX_TOKENS = 12000;
const DEFAULT_GEMMA_MODEL_REPO =
  "mradermacher/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking-i1-GGUF";
const DEFAULT_GEMMA_MMPROJ_REPO =
  "mradermacher/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking-GGUF";
const DEFAULT_GEMMA_MMPROJ_FILE =
  "gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.mmproj-f16.gguf";
const MODEL_PRESETS = {
  iq3s: {
    label: "IQ3_S",
    modelRepo: DEFAULT_GEMMA_MODEL_REPO,
    modelFile: "gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.i1-IQ3_S.gguf",
    mmprojRepo: DEFAULT_GEMMA_MMPROJ_REPO,
    mmprojFile: DEFAULT_GEMMA_MMPROJ_FILE
  }
} as const;

type ModelPresetId = keyof typeof MODEL_PRESETS | "custom";
type ModelSourceOption = {
  id: ModelSource;
  label: string;
  description: string;
};

type ModelProviderOption = {
  id: ModelProvider;
  label: string;
  description: string;
};

type CodexReasoningOption = {
  id: CodexReasoningEffort;
  label: string;
  description: string;
};

type OcrDeviceOption = {
  id: OcrDevice;
  label: string;
  description: string;
};

type GemmaVramModeOption = {
  id: GemmaVramMode;
  label: string;
  description: string;
};

type TestState =
  | {
      status: "idle";
      message: null;
      detail: null;
    }
  | {
      status: "running" | "success" | "error";
      message: string;
      detail: string | null;
    };

const MODEL_SOURCE_OPTIONS: ModelSourceOption[] = [
  {
    id: "huggingface",
    label: "HF repo",
    description: "기본 프리셋이나 Hugging Face repo/GGUF 파일명을 사용합니다."
  },
  {
    id: "local",
    label: "로컬 파일",
    description: "이미 가지고 있는 GGUF 모델과 mmproj를 직접 지정합니다."
  }
];

const MODEL_PROVIDER_OPTIONS: ModelProviderOption[] = [
  {
    id: "gemma",
    label: "Gemma 4",
    description: "로컬 llama-server로 Gemma 4 비전 모델을 실행합니다."
  },
  {
    id: "openai-codex",
    label: "OpenAI Codex",
    description: "Codex 로그인 토큰을 쓰는 openai-oauth 엔드포인트로 요청합니다."
  }
];

const CODEX_REASONING_OPTIONS: CodexReasoningOption[] = [
  {
    id: "none",
    label: "없음",
    description: "생각 예산을 쓰지 않고 가장 빠르게 응답합니다."
  },
  {
    id: "low",
    label: "낮음",
    description: "가벼운 추론으로 처리합니다."
  },
  {
    id: "medium",
    label: "보통",
    description: "기본 균형 설정입니다."
  },
  {
    id: "high",
    label: "높음",
    description: "더 오래 생각해서 까다로운 페이지를 처리합니다."
  },
  {
    id: "xhigh",
    label: "최고",
    description: "가장 넉넉한 생각 예산을 사용합니다."
  }
];

const OCR_DEVICE_OPTIONS: OcrDeviceOption[] = [
  {
    id: "cpu",
    label: "CPU",
    description: "기본값입니다. 느리지만 별도 GPU Paddle 런타임 없이 가장 안정적으로 동작합니다."
  },
  {
    id: "gpu",
    label: "GPU",
    description: "PaddleOCR를 GPU로 실행합니다. GPU용 Paddle 런타임/CUDA가 맞지 않으면 OCR 단계가 실패할 수 있습니다."
  }
];

const GEMMA_VRAM_MODE_OPTIONS: GemmaVramModeOption[] = [
  {
    id: "full",
    label: "풀로드",
    description: "현재 품질 기준입니다. 이미지 토큰은 그대로 쓰고, 넉넉한 VRAM에서 가장 여유 있게 실행합니다."
  },
  {
    id: "economy",
    label: "절약",
    description: "이미지 토큰 1024는 유지하고 batch/ubatch와 KV GPU 사용을 줄입니다. 16GB급 VRAM에서 더 안전하지만 조금 느릴 수 있습니다."
  }
];

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
  onSubmit
}: SettingsModalProps): React.JSX.Element {
  const [modelProvider, setModelProvider] = React.useState<ModelProvider>(initialSettings.modelProvider);
  const [modelSource, setModelSource] = React.useState<ModelSource>(initialSettings.gemma.modelSource);
  const [selectedPreset, setSelectedPreset] = React.useState<ModelPresetId>(() =>
    resolveModelPreset(initialSettings.gemma.modelRepo, initialSettings.gemma.modelFile)
  );
  const [customModelRepo, setCustomModelRepo] = React.useState(initialSettings.gemma.modelRepo);
  const [customModelFile, setCustomModelFile] = React.useState(initialSettings.gemma.modelFile);
  const [localModelPath, setLocalModelPath] = React.useState(initialSettings.gemma.localModelPath ?? "");
  const [localMmprojPath, setLocalMmprojPath] = React.useState(initialSettings.gemma.localMmprojPath ?? "");
  const [gpuLayers, setGpuLayers] = React.useState(String(clampGpuLayers(initialSettings.gemma.gpuLayers)));
  const [vramMode, setVramMode] = React.useState<GemmaVramMode>(initialSettings.gemma.vramMode);
  const [codexModel, setCodexModel] = React.useState(initialSettings.codex.model);
  const [codexReasoningEffort, setCodexReasoningEffort] = React.useState<CodexReasoningEffort>(
    initialSettings.codex.reasoningEffort
  );
  const [codexOauthPort, setCodexOauthPort] = React.useState(String(initialSettings.codex.oauthPort));
  const [ocrDevice, setOcrDevice] = React.useState<OcrDevice>(initialSettings.ocr.device);
  const [maxTokens, setMaxTokens] = React.useState(String(initialSettings.maxTokens));
  const [localActionBusy, setLocalActionBusy] = React.useState(false);
  const [testState, setTestState] = React.useState<TestState>({ status: "idle", message: null, detail: null });
  const [testLogLines, setTestLogLines] = React.useState<string[]>([]);
  const modelRepoInputRef = React.useRef<HTMLInputElement | null>(null);
  const localModelInputRef = React.useRef<HTMLInputElement | null>(null);
  const gpuSliderRef = React.useRef<HTMLInputElement | null>(null);
  const testLogRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    setModelProvider(initialSettings.modelProvider);
    setModelSource(initialSettings.gemma.modelSource);
    setSelectedPreset(resolveModelPreset(initialSettings.gemma.modelRepo, initialSettings.gemma.modelFile));
    setCustomModelRepo(initialSettings.gemma.modelRepo);
    setCustomModelFile(initialSettings.gemma.modelFile);
    setLocalModelPath(initialSettings.gemma.localModelPath ?? "");
    setLocalMmprojPath(initialSettings.gemma.localMmprojPath ?? "");
    setGpuLayers(String(clampGpuLayers(initialSettings.gemma.gpuLayers)));
    setVramMode(initialSettings.gemma.vramMode);
    setCodexModel(initialSettings.codex.model);
    setCodexReasoningEffort(initialSettings.codex.reasoningEffort);
    setCodexOauthPort(String(initialSettings.codex.oauthPort));
    setOcrDevice(initialSettings.ocr.device);
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
      return;
    }
    gpuSliderRef.current?.focus();
  }, [modelProvider, modelSource, selectedPreset]);

  const controlsBusy = busy || localActionBusy || testState.status === "running";
  const activePreset = modelSource === "huggingface" && selectedPreset !== "custom" ? MODEL_PRESETS[selectedPreset] : null;
  const trimmedModelRepo = (activePreset?.modelRepo ?? customModelRepo).trim();
  const trimmedModelFile = (activePreset?.modelFile ?? customModelFile).trim();
  const trimmedMmprojRepo = activePreset?.mmprojRepo;
  const trimmedMmprojFile = activePreset?.mmprojFile;
  const trimmedLocalModelPath = localModelPath.trim();
  const trimmedLocalMmprojPath = localMmprojPath.trim();
  const trimmedCodexModel = codexModel.trim();
  const parsedGpuLayers = Number(gpuLayers);
  const parsedCodexOauthPort = Number(codexOauthPort);
  const parsedMaxTokens = Number(maxTokens);
  const gpuLayersValid =
    Number.isInteger(parsedGpuLayers) && parsedGpuLayers >= 0 && parsedGpuLayers <= MAX_GPU_LAYERS;
  const codexOauthPortValid =
    Number.isInteger(parsedCodexOauthPort) && parsedCodexOauthPort >= 0 && parsedCodexOauthPort <= 65535;
  const maxTokensValid =
    Number.isInteger(parsedMaxTokens) && parsedMaxTokens >= MIN_MAX_TOKENS && parsedMaxTokens <= MAX_MAX_TOKENS;
  const canSubmit = Boolean(
    maxTokensValid &&
      (modelProvider === "openai-codex"
        ? trimmedCodexModel && codexOauthPortValid
        : gpuLayersValid && (modelSource === "local" ? trimmedLocalModelPath : trimmedModelRepo && trimmedModelFile))
  );
  const sliderValue =
    Number.isFinite(parsedGpuLayers) ? clampGpuLayers(Math.trunc(parsedGpuLayers)) : 0;

  const buildSettings = React.useCallback((): AppSettings | null => {
    if (!maxTokensValid) {
      return null;
    }

    if (modelProvider === "openai-codex") {
      if (!trimmedCodexModel || !codexOauthPortValid) {
        return null;
      }

      return {
        modelProvider,
        gemma: {
          modelSource,
          modelRepo: trimmedModelRepo || DEFAULT_GEMMA_MODEL_REPO,
          modelFile: trimmedModelFile || MODEL_PRESETS.iq3s.modelFile,
          ...(trimmedMmprojRepo ? { mmprojRepo: trimmedMmprojRepo } : {}),
          ...(trimmedMmprojFile ? { mmprojFile: trimmedMmprojFile } : {}),
          ...(trimmedLocalModelPath ? { localModelPath: trimmedLocalModelPath } : {}),
          ...(trimmedLocalMmprojPath ? { localMmprojPath: trimmedLocalMmprojPath } : {}),
          gpuLayers: gpuLayersValid ? parsedGpuLayers : initialSettings.gemma.gpuLayers,
          vramMode
        },
        codex: {
          model: trimmedCodexModel,
          reasoningEffort: codexReasoningEffort,
          oauthPort: parsedCodexOauthPort
        },
        ocr: {
          device: ocrDevice
        },
        maxTokens: parsedMaxTokens
      };
    }

    if (!gpuLayersValid) {
      return null;
    }

    return {
      modelProvider,
      gemma: {
        modelSource,
        modelRepo: trimmedModelRepo || DEFAULT_GEMMA_MODEL_REPO,
        modelFile: trimmedModelFile || MODEL_PRESETS.iq3s.modelFile,
        ...(trimmedMmprojRepo ? { mmprojRepo: trimmedMmprojRepo } : {}),
        ...(trimmedMmprojFile ? { mmprojFile: trimmedMmprojFile } : {}),
        ...(trimmedLocalModelPath ? { localModelPath: trimmedLocalModelPath } : {}),
        ...(trimmedLocalMmprojPath ? { localMmprojPath: trimmedLocalMmprojPath } : {}),
        gpuLayers: parsedGpuLayers,
        vramMode
      },
      codex: {
        model: trimmedCodexModel || initialSettings.codex.model,
        reasoningEffort: codexReasoningEffort,
        oauthPort: codexOauthPortValid ? parsedCodexOauthPort : initialSettings.codex.oauthPort
      },
      ocr: {
        device: ocrDevice
      },
      maxTokens: parsedMaxTokens
    };
  }, [
    modelProvider,
    gpuLayersValid,
    codexOauthPortValid,
    modelSource,
    trimmedModelRepo,
    trimmedModelFile,
    trimmedMmprojRepo,
    trimmedMmprojFile,
    trimmedLocalModelPath,
    trimmedLocalMmprojPath,
    trimmedCodexModel,
    parsedGpuLayers,
    parsedCodexOauthPort,
    parsedMaxTokens,
    vramMode,
    codexReasoningEffort,
    ocrDevice,
    initialSettings.gemma.gpuLayers,
    initialSettings.codex.model,
    initialSettings.codex.oauthPort,
    maxTokensValid
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

  const submit = () => {
    const nextSettings = buildSettings();
    if (!nextSettings || !canSubmit) {
      return;
    }
    onSubmit(nextSettings);
  };

  const handleGpuLayersInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    clearTestState();
    const nextValue = event.target.value;
    if (!nextValue) {
      setGpuLayers("");
      return;
    }

    const parsed = Number(nextValue);
    if (!Number.isFinite(parsed)) {
      setGpuLayers(nextValue);
      return;
    }

    if (parsed < 0) {
      setGpuLayers("0");
      return;
    }

    if (parsed > MAX_GPU_LAYERS) {
      setGpuLayers(String(MAX_GPU_LAYERS));
      return;
    }

    setGpuLayers(nextValue);
  };

  const pickLocalModelFile = async () => {
    setLocalActionBusy(true);
    try {
      const picked = await window.mangaApi.pickLocalModelFile();
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
  };

  const pickLocalMmprojFile = async () => {
    setLocalActionBusy(true);
    try {
      const picked = await window.mangaApi.pickLocalMmprojFile();
      if (!picked) {
        return;
      }
      clearTestState();
      setLocalMmprojPath(picked);
    } finally {
      setLocalActionBusy(false);
    }
  };

  const runModelTest = async () => {
    const nextSettings = buildSettings();
    if (!nextSettings || !canSubmit || jobActive) {
      return;
    }

    const testId = `settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setTestLogLines(["모델 테스트를 시작합니다."]);
    setTestState({
      status: "running",
      message: "모델을 불러오고 간단한 텍스트 응답을 확인하는 중입니다...",
      detail: "이 테스트는 모델 로드와 텍스트 응답만 확인합니다."
    });
    const unsubscribe = window.mangaApi.onModelTestEvent((event) => {
      if (event.id !== testId) {
        return;
      }
      appendTestLogLine(formatModelTestProgressLine(event));
      setTestState((current) =>
        current.status === "running"
          ? {
              status: "running",
              message: event.progressText,
              detail: event.detail ?? current.detail
            }
          : current
      );
    });
    try {
      const result = await window.mangaApi.testModelSettings(nextSettings, testId);
      appendTestLogLine(result.ok ? "모델 테스트가 완료되었습니다." : "모델 테스트가 실패했습니다.");
      setTestState({
        status: result.ok ? "success" : "error",
        message: result.message,
        detail: buildTestDetail(result.resolvedModelPath, result.resolvedMmprojPath, result.resolvedEndpoint)
      });
    } catch (error) {
      appendTestLogLine("모델 테스트 요청 중 오류가 발생했습니다.");
      setTestState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        detail: null
      });
    } finally {
      unsubscribe();
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-card settings-modal">
        <div className="modal-header">
          <h2>설정</h2>
          <button className="ghost-button" onClick={onCancel} disabled={controlsBusy}>
            닫기
          </button>
        </div>

        <section className="modal-section">
          <p className="muted-line modal-note">다음 번 번역 실행부터 적용됩니다.</p>
          <div className="settings-field-stack">
            <span>번역 엔진</span>
            <div className="settings-mode-group" role="tablist" aria-label="번역 엔진">
              {MODEL_PROVIDER_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`settings-preset-button ${modelProvider === option.id ? "active" : ""}`}
                  onClick={() => {
                    clearTestState();
                    setModelProvider(option.id);
                  }}
                  disabled={controlsBusy}
                  aria-pressed={modelProvider === option.id}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="muted-line modal-note">
              {MODEL_PROVIDER_OPTIONS.find((option) => option.id === modelProvider)?.description}
            </p>
          </div>

          <label>
            최대 출력 토큰
            <input
              type="number"
              min={MIN_MAX_TOKENS}
              max={MAX_MAX_TOKENS}
              step={100}
              value={maxTokens}
              disabled={controlsBusy}
              onChange={(event) => {
                clearTestState();
                setMaxTokens(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  submit();
                }
              }}
            />
          </label>
          <p className="muted-line modal-note">
            출력이 길어지는 페이지에서 말풍선 누락을 줄입니다. 기본값은 12000입니다.
          </p>

          <div className="settings-field-stack">
            <span>Paddle OCR 장치</span>
            <div className="settings-mode-group" role="tablist" aria-label="Paddle OCR 장치">
              {OCR_DEVICE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`settings-preset-button ${ocrDevice === option.id ? "active" : ""}`}
                  onClick={() => {
                    clearTestState();
                    setOcrDevice(option.id);
                  }}
                  disabled={controlsBusy}
                  aria-pressed={ocrDevice === option.id}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="muted-line modal-note">
              {OCR_DEVICE_OPTIONS.find((option) => option.id === ocrDevice)?.description}
            </p>
          </div>

          {modelProvider === "gemma" ? (
            <>
          <div className="settings-field-stack">
            <span>모델 소스</span>
            <div className="settings-mode-group" role="tablist" aria-label="모델 소스">
              {MODEL_SOURCE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`settings-preset-button ${modelSource === option.id ? "active" : ""}`}
                  onClick={() => {
                    clearTestState();
                    setModelSource(option.id);
                  }}
                  disabled={controlsBusy}
                  aria-pressed={modelSource === option.id}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="muted-line modal-note">
              {MODEL_SOURCE_OPTIONS.find((option) => option.id === modelSource)?.description}
            </p>
          </div>

          {modelSource === "huggingface" ? (
            <>
              <div className="settings-field-stack">
                <span>모델</span>
                <div className="settings-preset-group" role="tablist" aria-label="모델 프리셋">
                  {(["iq3s", "custom"] as const).map((presetId) => (
                    <button
                      key={presetId}
                      type="button"
                      className={`settings-preset-button ${selectedPreset === presetId ? "active" : ""}`}
                      onClick={() => {
                        clearTestState();
                        setSelectedPreset(presetId);
                      }}
                      disabled={controlsBusy}
                      aria-pressed={selectedPreset === presetId}
                    >
                      {presetId === "custom" ? "커스텀" : MODEL_PRESETS[presetId].label}
                    </button>
                  ))}
                </div>
                <p className="muted-line modal-note">
                  기본값은 IQ3_S입니다. mmproj는 별도 Hugging Face repo에서 자동으로 받아옵니다.
                </p>
              </div>
              {selectedPreset === "custom" ? (
                <>
                  <label>
                    HF repo
                    <input
                      ref={modelRepoInputRef}
                      value={customModelRepo}
                      disabled={controlsBusy}
                      onChange={(event) => {
                        clearTestState();
                        setCustomModelRepo(event.target.value);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          submit();
                        }
                      }}
                    />
                  </label>
                  <label>
                    GGUF 파일명
                    <input
                      value={customModelFile}
                      disabled={controlsBusy}
                      onChange={(event) => {
                        clearTestState();
                        setCustomModelFile(event.target.value);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          submit();
                        }
                      }}
                    />
                  </label>
                </>
              ) : null}
            </>
          ) : (
            <>
              <div className="settings-field-stack">
                <span>로컬 모델 파일</span>
                <div className="settings-file-row">
                  <input
                    ref={localModelInputRef}
                    value={localModelPath}
                    disabled={controlsBusy}
                    onChange={(event) => {
                      clearTestState();
                      setLocalModelPath(event.target.value);
                    }}
                    placeholder="C:\\models\\my-model.gguf"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        submit();
                      }
                    }}
                  />
                  <button type="button" onClick={() => void pickLocalModelFile()} disabled={controlsBusy}>
                    파일 선택
                  </button>
                </div>
              </div>

              <div className="settings-field-stack">
                <span>mmproj 파일</span>
                <div className="settings-file-row">
                  <input
                    value={localMmprojPath}
                    disabled={controlsBusy}
                    onChange={(event) => {
                      clearTestState();
                      setLocalMmprojPath(event.target.value);
                    }}
                    placeholder="같은 폴더면 자동 탐지, 필요하면 직접 지정"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        submit();
                      }
                    }}
                  />
                  <button type="button" onClick={() => void pickLocalMmprojFile()} disabled={controlsBusy}>
                    파일 선택
                  </button>
                </div>
                <p className="muted-line modal-note">
                  mmproj는 같은 폴더에서 자동으로 찾아보고, 안 잡히면 직접 지정할 수 있습니다.
                </p>
              </div>
            </>
          )}

          <div className="settings-field-stack">
            <span>VRAM 모드</span>
            <div className="settings-mode-group" role="tablist" aria-label="Gemma VRAM 모드">
              {GEMMA_VRAM_MODE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`settings-preset-button ${vramMode === option.id ? "active" : ""}`}
                  onClick={() => {
                    clearTestState();
                    setVramMode(option.id);
                  }}
                  disabled={controlsBusy}
                  aria-pressed={vramMode === option.id}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="muted-line modal-note">
              {GEMMA_VRAM_MODE_OPTIONS.find((option) => option.id === vramMode)?.description}
            </p>
          </div>

          <div className="settings-field-stack">
            <span>GPU layers</span>
            <div className="settings-gpu-row">
              <input
                ref={gpuSliderRef}
                className="settings-gpu-slider"
                type="range"
                min={0}
                max={MAX_GPU_LAYERS}
                step={1}
                value={sliderValue}
                disabled={controlsBusy}
                onChange={(event) => {
                  clearTestState();
                  setGpuLayers(String(clampGpuLayers(Number(event.target.value))));
                }}
              />
              <input
                className="settings-gpu-input"
                type="number"
                min={0}
                max={MAX_GPU_LAYERS}
                step={1}
                value={gpuLayers}
                disabled={controlsBusy}
                onChange={handleGpuLayersInputChange}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    submit();
                  }
                }}
              />
            </div>
            <p className="muted-line modal-note">
              기본 Gemma 4 31B 모델은 beellama 스모크 테스트와 같은 안정 설정으로 전체 GPU 로드를 사용합니다.
              이 값은 커스텀 로컬 모델이나 진단 환경에서만 직접 반영될 수 있으며, VRAM 절약은 위의 절약 모드를 사용하세요.
            </p>
          </div>
            </>
          ) : (
            <>
              <label>
                Codex 모델
                <input
                  value={codexModel}
                  disabled={controlsBusy}
                  onChange={(event) => {
                    clearTestState();
                    setCodexModel(event.target.value);
                  }}
                  placeholder="gpt-5.5"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      submit();
                    }
                  }}
                />
              </label>

              <div className="settings-field-stack">
                <span>생각</span>
                <div className="settings-preset-group" role="tablist" aria-label="Codex 생각">
                  {CODEX_REASONING_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={`settings-preset-button ${codexReasoningEffort === option.id ? "active" : ""}`}
                      onClick={() => {
                        clearTestState();
                        setCodexReasoningEffort(option.id);
                      }}
                      disabled={controlsBusy}
                      aria-pressed={codexReasoningEffort === option.id}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <p className="muted-line modal-note">
                  {CODEX_REASONING_OPTIONS.find((option) => option.id === codexReasoningEffort)?.description}
                </p>
              </div>

              <label>
                openai-oauth 포트
                <input
                  type="number"
                  min={0}
                  max={65535}
                  step={1}
                  value={codexOauthPort}
                  disabled={controlsBusy}
                  onChange={(event) => {
                    clearTestState();
                    setCodexOauthPort(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      submit();
                    }
                  }}
                />
              </label>
            </>
          )}

          <div className="settings-field-stack">
            <span>모델 테스트</span>
            <div className="settings-inline-actions">
              <button
                type="button"
                onClick={() => void runModelTest()}
                disabled={controlsBusy || !canSubmit || jobActive}
              >
                {testState.status === "running" ? "테스트 중..." : "잘 작동되나 확인"}
              </button>
            </div>
            <p className="muted-line modal-note">
              서버가 뜨고 간단한 텍스트 요청에 응답하는지만 확인합니다. 실제 이미지 번역 가능 여부와는 다를 수 있습니다.
            </p>
            {jobActive ? <p className="muted-line">번역 작업 중에는 모델 테스트를 실행할 수 없습니다.</p> : null}
            {testState.status !== "idle" ? (
              <div className={`settings-test-result ${testState.status}`}>
                <strong>{testState.message}</strong>
                {testState.detail ? <p>{testState.detail}</p> : null}
              </div>
            ) : null}
            {testLogLines.length > 0 ? (
              <div className="settings-test-log" ref={testLogRef} aria-label="모델 테스트 로그">
                {testLogLines.map((line, index) => (
                  <code key={`${index}-${line}`}>{line}</code>
                ))}
              </div>
            ) : null}
          </div>

          {modelProvider === "gemma" && !gpuLayersValid ? (
            <p className="muted-line">GPU layers는 0 이상 30 이하의 정수여야 합니다.</p>
          ) : null}
          {modelProvider === "openai-codex" && !codexOauthPortValid ? (
            <p className="muted-line">openai-oauth 포트는 0 이상 65535 이하의 정수여야 합니다.</p>
          ) : null}
          {!maxTokensValid ? (
            <p className="muted-line">최대 출력 토큰은 {MIN_MAX_TOKENS} 이상 {MAX_MAX_TOKENS} 이하의 정수여야 합니다.</p>
          ) : null}
        </section>

        <div className="modal-actions settings-actions">
          <button className="ghost-button" onClick={onOpenLogFolder} disabled={controlsBusy}>
            로그 폴더 열기
          </button>
          <button onClick={onReset} disabled={controlsBusy}>
            기본값 복원
          </button>
          <button onClick={onCancel} disabled={controlsBusy}>
            취소
          </button>
          <button className="primary" onClick={submit} disabled={controlsBusy || !canSubmit}>
            저장
          </button>
        </div>
      </div>
    </div>
  );
}

function resolveModelPreset(modelRepo: string, modelFile: string): ModelPresetId {
  const trimmedModelRepo = modelRepo.trim();
  const trimmedModelFile = modelFile.trim();

  if (matchesPreset(MODEL_PRESETS.iq3s, trimmedModelRepo, trimmedModelFile)) {
    return "iq3s";
  }

  return "custom";
}

function matchesPreset(
  preset: (typeof MODEL_PRESETS)[keyof typeof MODEL_PRESETS],
  modelRepo: string,
  modelFile: string
): boolean {
  return preset.modelRepo === modelRepo && preset.modelFile === modelFile;
}

function clampGpuLayers(value: number): number {
  return Math.min(MAX_GPU_LAYERS, Math.max(0, value));
}

function buildTestDetail(
  modelPath: string | null | undefined,
  mmprojPath: string | null | undefined,
  endpoint: string | null | undefined
): string | null {
  const lines = [
    modelPath ? `모델: ${modelPath}` : null,
    mmprojPath ? `mmproj: ${mmprojPath}` : null,
    endpoint ? `엔드포인트: ${endpoint}` : null
  ].filter(Boolean);

  return lines.length > 0 ? lines.join("\n") : null;
}

function formatModelTestProgressLine(event: ModelTestProgressEvent): string {
  const percent =
    event.progressMode !== "log-only" && typeof event.progressPercent === "number" && Number.isFinite(event.progressPercent)
      ? `${Math.round(event.progressPercent * 100)}% `
      : "";
  if (event.installLogLine?.trim()) {
    return `${percent}${event.installLogLine.trim()}`;
  }
  const detail = event.detail?.trim();
  return detail ? `${percent}${event.progressText} - ${detail}` : `${percent}${event.progressText}`;
}
