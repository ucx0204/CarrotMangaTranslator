import React from "react";
import type {
  FluxBackend,
  OcrDevice,
  OcrGpuBackend,
} from "../../../../shared/types";
import { mangaGateway } from "../../api/mangaGateway";
import { FLUX_BACKEND_OPTIONS, OCR_DEVICE_OPTIONS } from "../settingsOptions";

type HardwareSettingsPanelProps = {
  clearTestState: () => void;
  controlsBusy: boolean;
  fluxBackend: FluxBackend;
  isFluxBackendOptionDisabled: (backend: FluxBackend) => boolean;
  ocrGpuBackend: OcrGpuBackend;
  ocrDevice: OcrDevice;
  setFluxBackend: React.Dispatch<React.SetStateAction<FluxBackend>>;
  setOcrDevice: React.Dispatch<React.SetStateAction<OcrDevice>>;
  setOcrGpuBackend: React.Dispatch<React.SetStateAction<OcrGpuBackend>>;
  usesAmdHardware: boolean;
  usesAmdOcrContext: boolean;
  usesNvidiaHardware: boolean;
  usesNvidiaOcrContext: boolean;
};

export function HardwareSettingsPanel({
  clearTestState,
  controlsBusy,
  fluxBackend,
  isFluxBackendOptionDisabled,
  ocrGpuBackend,
  ocrDevice,
  setFluxBackend,
  setOcrDevice,
  setOcrGpuBackend,
  usesAmdHardware,
  usesAmdOcrContext,
  usesNvidiaHardware,
  usesNvidiaOcrContext,
}: HardwareSettingsPanelProps): React.JSX.Element {
  const activeOcrOptionId = ocrDevice === "cpu" ? "cpu" : ocrGpuBackend;
  const activeOcrOption = OCR_DEVICE_OPTIONS.find(
    (option) => option.id === activeOcrOptionId,
  );
  const ocrDescription =
    usesAmdOcrContext && activeOcrOptionId === "rocm-transformers"
      ? "AMD OCR GPU는 실험 기능입니다. PaddlePaddle CUDA가 아니라 PyTorch ROCm + Transformers engine을 사용하며, 실패하면 OCR만 CPU로 바꿀 수 있습니다."
      : activeOcrOption?.description;

  return (
    <>
      <div className="settings-field-stack">
        <span>Paddle OCR 장치</span>
        <div
          className="settings-preset-group"
          role="tablist"
          aria-label="Paddle OCR 장치"
        >
          {OCR_DEVICE_OPTIONS.map((option) => {
            const disabled =
              controlsBusy ||
              (option.id === "cuda" && usesAmdOcrContext) ||
              (option.id === "rocm-transformers" && usesNvidiaOcrContext);
            return (
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
                disabled={disabled}
                aria-pressed={activeOcrOptionId === option.id}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        <p className="muted-line modal-note">{ocrDescription}</p>
        {usesAmdOcrContext ? (
          <p className="muted-line modal-note">
            AMD 환경에서는 NVIDIA CUDA OCR을 선택할 수 없습니다.
          </p>
        ) : usesNvidiaOcrContext ? (
          <p className="muted-line modal-note">
            NVIDIA 환경에서는 AMD ROCm OCR을 선택할 수 없습니다.
          </p>
        ) : null}
      </div>

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
          {
            FLUX_BACKEND_OPTIONS.find((option) => option.id === fluxBackend)
              ?.description
          }
        </p>
        {fluxBackend === "zluda-native" ? (
          <button
            type="button"
            className="settings-external-link"
            onClick={() => {
              void mangaGateway.openAmdHipSdkDownload().catch((error) => {
                console.error(
                  "Failed to open AMD HIP SDK download page",
                  error,
                );
              });
            }}
          >
            AMD HIP SDK 다운로드 (ROCm 7.1.1)
          </button>
        ) : null}
        {usesAmdHardware ? (
          <p className="muted-line modal-note">
            감지된 AMD GPU에서는 CUDA 네이티브 백엔드를 쓸 수 없어 ZLUDA 또는
            CPU 중에서 선택합니다.
          </p>
        ) : usesNvidiaHardware ? (
          <p className="muted-line modal-note">
            감지된 NVIDIA GPU에서는 ZLUDA 백엔드 대신 CUDA 네이티브를
            사용합니다.
          </p>
        ) : null}
      </div>
    </>
  );
}
