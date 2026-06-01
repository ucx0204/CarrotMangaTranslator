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
import {
  CODEX_REASONING_OPTIONS,
  DEFAULT_GEMMA_MODEL_REPO,
  GEMMA_VRAM_MODE_OPTIONS,
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS,
  MODEL_PRESETS,
  MODEL_PROVIDER_OPTIONS,
  MODEL_SOURCE_OPTIONS,
  OCR_DEVICE_OPTIONS,
  resolveModelPreset,
  type ModelPresetId
} from "./settingsOptions";

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
  const testLogRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    setModelProvider(initialSettings.modelProvider);
    setModelSource(initialSettings.gemma.modelSource);
    setSelectedPreset(resolveModelPreset(initialSettings.gemma.modelRepo, initialSettings.gemma.modelFile));
    setCustomModelRepo(initialSettings.gemma.modelRepo);
    setCustomModelFile(initialSettings.gemma.modelFile);
    setLocalModelPath(initialSettings.gemma.localModelPath ?? "");
    setLocalMmprojPath(initialSettings.gemma.localMmprojPath ?? "");
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
    }
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
  const parsedCodexOauthPort = Number(codexOauthPort);
  const parsedMaxTokens = Number(maxTokens);
  const codexOauthPortValid =
    Number.isInteger(parsedCodexOauthPort) && parsedCodexOauthPort >= 0 && parsedCodexOauthPort <= 65535;
  const maxTokensValid =
    Number.isInteger(parsedMaxTokens) && parsedMaxTokens >= MIN_MAX_TOKENS && parsedMaxTokens <= MAX_MAX_TOKENS;
  const gemmaSettingsReady = modelSource === "local" ? Boolean(trimmedLocalModelPath) : Boolean(trimmedModelRepo && trimmedModelFile);
  const canSubmit = Boolean(
    maxTokensValid &&
      (modelProvider === "openai-codex" ? trimmedCodexModel && codexOauthPortValid : gemmaSettingsReady)
  );

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
          vramMode
        },
        codex: {
          model: trimmedCodexModel,
          reasoningEffort: codexReasoningEffort,
          oauthPort: parsedCodexOauthPort
        },
        ocr: {
          device: ocrDevice,
          ...(initialSettings.ocr.gpuCudaTag ? { gpuCudaTag: initialSettings.ocr.gpuCudaTag } : {})
        },
        maxTokens: parsedMaxTokens
      };
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
        vramMode
      },
      codex: {
        model: trimmedCodexModel || initialSettings.codex.model,
        reasoningEffort: codexReasoningEffort,
        oauthPort: codexOauthPortValid ? parsedCodexOauthPort : initialSettings.codex.oauthPort
      },
      ocr: {
        device: ocrDevice,
        ...(initialSettings.ocr.gpuCudaTag ? { gpuCudaTag: initialSettings.ocr.gpuCudaTag } : {})
      },
      maxTokens: parsedMaxTokens
    };
  }, [
    modelProvider,
    codexOauthPortValid,
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
    vramMode,
    codexReasoningEffort,
    ocrDevice,
    initialSettings.codex.model,
    initialSettings.codex.oauthPort,
    initialSettings.ocr.gpuCudaTag,
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
