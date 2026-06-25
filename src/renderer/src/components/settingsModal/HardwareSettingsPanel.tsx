import React from "react";
import type {
  FluxBackend,
  InpaintingModel,
  OcrDevice,
  OcrGpuBackend,
  OcrQualityMode,
} from "../../../../shared/settingsTypes";
import { mangaGateway } from "../../api/mangaGateway";
import {
  FLUX_BACKEND_OPTIONS,
  INPAINTING_MODEL_OPTIONS,
  OCR_DEVICE_OPTIONS,
  OCR_QUALITY_OPTIONS,
} from "../settingsOptions";

type HardwareSettingsPanelProps = {
  clearTestState: () => void;
  controlsBusy: boolean;
  fluxBackend: FluxBackend;
  inpaintingModel: InpaintingModel;
  isFluxBackendOptionDisabled: (backend: FluxBackend) => boolean;
  ocrGpuBackend: OcrGpuBackend;
  ocrDevice: OcrDevice;
  ocrQualityMode: OcrQualityMode;
  setFluxBackend: React.Dispatch<React.SetStateAction<FluxBackend>>;
  setInpaintingModel: React.Dispatch<React.SetStateAction<InpaintingModel>>;
  setOcrDevice: React.Dispatch<React.SetStateAction<OcrDevice>>;
  setOcrGpuBackend: React.Dispatch<React.SetStateAction<OcrGpuBackend>>;
  setOcrQualityMode: React.Dispatch<React.SetStateAction<OcrQualityMode>>;
  usesAmdHardware: boolean;
  usesAmdOcrContext: boolean;
  usesNvidiaHardware: boolean;
  usesNvidiaOcrContext: boolean;
};

export function HardwareSettingsPanel({
  clearTestState,
  controlsBusy,
  fluxBackend,
  inpaintingModel,
  isFluxBackendOptionDisabled,
  ocrGpuBackend,
  ocrDevice,
  ocrQualityMode,
  setFluxBackend,
  setInpaintingModel,
  setOcrDevice,
  setOcrGpuBackend,
  setOcrQualityMode,
  usesAmdHardware,
  usesAmdOcrContext,
  usesNvidiaHardware,
  usesNvidiaOcrContext,
}: HardwareSettingsPanelProps): React.JSX.Element {
  return (
    <>
      <OcrQualitySettings
        clearTestState={clearTestState}
        controlsBusy={controlsBusy}
        ocrQualityMode={ocrQualityMode}
        setOcrDevice={setOcrDevice}
        setOcrGpuBackend={setOcrGpuBackend}
        setOcrQualityMode={setOcrQualityMode}
        usesAmdOcrContext={usesAmdOcrContext}
        usesNvidiaOcrContext={usesNvidiaOcrContext}
      />
      <OcrDeviceSettings
        clearTestState={clearTestState}
        controlsBusy={controlsBusy}
        ocrDevice={ocrDevice}
        ocrGpuBackend={ocrGpuBackend}
        setOcrDevice={setOcrDevice}
        setOcrGpuBackend={setOcrGpuBackend}
        usesAmdOcrContext={usesAmdOcrContext}
        usesNvidiaOcrContext={usesNvidiaOcrContext}
      />
      <InpaintingModelSettings
        clearTestState={clearTestState}
        inpaintingModel={inpaintingModel}
        setInpaintingModel={setInpaintingModel}
      />
      <FluxBackendSettings
        clearTestState={clearTestState}
        fluxBackend={fluxBackend}
        inpaintingModel={inpaintingModel}
        isFluxBackendOptionDisabled={isFluxBackendOptionDisabled}
        setFluxBackend={setFluxBackend}
        usesAmdHardware={usesAmdHardware}
        usesNvidiaHardware={usesNvidiaHardware}
      />
    </>
  );
}

function OcrQualitySettings({
  clearTestState,
  controlsBusy,
  ocrQualityMode,
  setOcrDevice,
  setOcrGpuBackend,
  setOcrQualityMode,
  usesAmdOcrContext,
  usesNvidiaOcrContext,
}: Pick<
  HardwareSettingsPanelProps,
  | "clearTestState"
  | "controlsBusy"
  | "ocrQualityMode"
  | "setOcrDevice"
  | "setOcrGpuBackend"
  | "setOcrQualityMode"
  | "usesAmdOcrContext"
  | "usesNvidiaOcrContext"
>): React.JSX.Element {
  const activeOption = OCR_QUALITY_OPTIONS.find(
    (option) => option.id === ocrQualityMode,
  );
  return (
    <div className="settings-field-stack">
      <span>Paddle OCR 품질</span>
      <div
        className="settings-preset-group"
        role="tablist"
        aria-label="Paddle OCR 품질"
      >
        {OCR_QUALITY_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`settings-preset-button ${ocrQualityMode === option.id ? "active" : ""}`}
            onClick={() => {
              clearTestState();
              if (option.id === "full") {
                setOcrDevice("gpu");
                if (usesAmdOcrContext) {
                  setOcrGpuBackend("rocm-transformers");
                } else if (usesNvidiaOcrContext) {
                  setOcrGpuBackend("cuda");
                }
              } else {
                setOcrDevice("cpu");
              }
              setOcrQualityMode(option.id);
            }}
            disabled={controlsBusy}
            aria-pressed={ocrQualityMode === option.id}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="muted-line modal-note">{activeOption?.description}</p>
    </div>
  );
}

function OcrDeviceSettings({
  clearTestState,
  controlsBusy,
  ocrDevice,
  ocrGpuBackend,
  setOcrDevice,
  setOcrGpuBackend,
  usesAmdOcrContext,
  usesNvidiaOcrContext,
}: Pick<
  HardwareSettingsPanelProps,
  | "clearTestState"
  | "controlsBusy"
  | "ocrDevice"
  | "ocrGpuBackend"
  | "setOcrDevice"
  | "setOcrGpuBackend"
  | "usesAmdOcrContext"
  | "usesNvidiaOcrContext"
>): React.JSX.Element {
  const activeOcrOptionId = ocrDevice === "cpu" ? "cpu" : ocrGpuBackend;
  const activeOcrOption = OCR_DEVICE_OPTIONS.find(
    (option) => option.id === activeOcrOptionId,
  );
  const ocrDescription =
    usesAmdOcrContext && activeOcrOptionId === "rocm-transformers"
      ? "AMD OCR GPU는 실험 기능입니다. PaddlePaddle CUDA가 아니라 PyTorch ROCm + Transformers engine을 사용하며, 실패하면 OCR만 CPU로 바꿀 수 있습니다."
      : activeOcrOption?.description;

  return (
    <div className="settings-field-stack">
      <span>Paddle OCR 장치</span>
      <div
        className="settings-preset-group"
        role="tablist"
        aria-label="Paddle OCR 장치"
      >
        {OCR_DEVICE_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`settings-preset-button ${activeOcrOptionId === option.id ? "active" : ""}`}
            onClick={() => {
              clearTestState();
              setOcrDevice(option.device);
              if (option.gpuBackend) {
                setOcrGpuBackend(option.gpuBackend);
              }
            }}
            disabled={isOcrOptionDisabled(
              option.id,
              controlsBusy,
              usesAmdOcrContext,
              usesNvidiaOcrContext,
            )}
            aria-pressed={activeOcrOptionId === option.id}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="muted-line modal-note">{ocrDescription}</p>
      <OcrHardwareContextNote
        usesAmdOcrContext={usesAmdOcrContext}
        usesNvidiaOcrContext={usesNvidiaOcrContext}
      />
    </div>
  );
}

function FluxBackendSettings({
  clearTestState,
  fluxBackend,
  inpaintingModel,
  isFluxBackendOptionDisabled,
  setFluxBackend,
  usesAmdHardware,
  usesNvidiaHardware,
}: Pick<
  HardwareSettingsPanelProps,
  | "clearTestState"
  | "fluxBackend"
  | "inpaintingModel"
  | "isFluxBackendOptionDisabled"
  | "setFluxBackend"
  | "usesAmdHardware"
  | "usesNvidiaHardware"
>): React.JSX.Element {
  return (
    <div className="settings-field-stack">
      <span>Flux 인페인팅 백엔드</span>
      <div
        className="settings-preset-group"
        role="tablist"
        aria-label="Flux 인페인팅 백엔드"
      >
        {FLUX_BACKEND_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`settings-preset-button ${fluxBackend === option.id ? "active" : ""}`}
            onClick={() => {
              clearTestState();
              setFluxBackend(option.id);
            }}
            disabled={isFluxBackendOptionDisabled(option.id)}
            aria-pressed={fluxBackend === option.id}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="muted-line modal-note">
        {inpaintingModel === "flux-klein"
          ? FLUX_BACKEND_OPTIONS.find((option) => option.id === fluxBackend)
              ?.description
          : "이 백엔드 설정은 Flux Klein 모델에서만 적용됩니다."}
      </p>
      {inpaintingModel === "flux-klein" && fluxBackend === "zluda-native" ? (
        <AmdHipSdkDownloadButton />
      ) : null}
      <FluxHardwareContextNote
        usesAmdHardware={usesAmdHardware}
        usesNvidiaHardware={usesNvidiaHardware}
      />
    </div>
  );
}

function InpaintingModelSettings({
  clearTestState,
  inpaintingModel,
  setInpaintingModel,
}: Pick<
  HardwareSettingsPanelProps,
  "clearTestState" | "inpaintingModel" | "setInpaintingModel"
>): React.JSX.Element {
  return (
    <div className="settings-field-stack">
      <span>인페인팅 모델</span>
      <div
        className="settings-preset-group"
        role="tablist"
        aria-label="인페인팅 모델"
      >
        {INPAINTING_MODEL_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`settings-preset-button ${inpaintingModel === option.id ? "active" : ""}`}
            onClick={() => {
              clearTestState();
              setInpaintingModel(option.id);
            }}
            aria-pressed={inpaintingModel === option.id}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="muted-line modal-note">
        {
          INPAINTING_MODEL_OPTIONS.find(
            (option) => option.id === inpaintingModel,
          )?.description
        }
      </p>
    </div>
  );
}

function OcrHardwareContextNote({
  usesAmdOcrContext,
  usesNvidiaOcrContext,
}: Pick<
  HardwareSettingsPanelProps,
  "usesAmdOcrContext" | "usesNvidiaOcrContext"
>): React.JSX.Element | null {
  if (usesAmdOcrContext) {
    return (
      <p className="muted-line modal-note">
        AMD 환경에서는 NVIDIA CUDA OCR을 선택할 수 없습니다.
      </p>
    );
  }
  if (usesNvidiaOcrContext) {
    return (
      <p className="muted-line modal-note">
        NVIDIA 환경에서는 AMD ROCm OCR을 선택할 수 없습니다.
      </p>
    );
  }
  return null;
}

function FluxHardwareContextNote({
  usesAmdHardware,
  usesNvidiaHardware,
}: Pick<
  HardwareSettingsPanelProps,
  "usesAmdHardware" | "usesNvidiaHardware"
>): React.JSX.Element | null {
  if (usesAmdHardware) {
    return (
      <p className="muted-line modal-note">
        감지된 AMD GPU에서는 CUDA 네이티브 백엔드를 쓸 수 없어 ZLUDA 또는 CPU
        중에서 선택합니다.
      </p>
    );
  }
  if (usesNvidiaHardware) {
    return (
      <p className="muted-line modal-note">
        감지된 NVIDIA GPU에서는 ZLUDA 백엔드 대신 CUDA 네이티브를 사용합니다.
      </p>
    );
  }
  return null;
}

function AmdHipSdkDownloadButton(): React.JSX.Element {
  return (
    <button
      type="button"
      className="settings-external-link"
      onClick={() => {
        void mangaGateway.openAmdHipSdkDownload().catch((error) => {
          console.error("Failed to open AMD HIP SDK download page", error);
        });
      }}
    >
      AMD HIP SDK 다운로드 (ROCm 7.1.1)
    </button>
  );
}

function isOcrOptionDisabled(
  optionId: string,
  controlsBusy: boolean,
  usesAmdOcrContext: boolean,
  usesNvidiaOcrContext: boolean,
): boolean {
  return (
    controlsBusy ||
    (optionId === "cuda" && usesAmdOcrContext) ||
    (optionId === "rocm-transformers" && usesNvidiaOcrContext)
  );
}
