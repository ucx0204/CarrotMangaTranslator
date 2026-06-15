import React from "react";
import type { FluxBackend, OcrDevice } from "../../../../shared/types";
import { FLUX_BACKEND_OPTIONS, OCR_DEVICE_OPTIONS } from "../settingsOptions";

type HardwareSettingsPanelProps = {
  clearTestState: () => void;
  controlsBusy: boolean;
  fluxBackend: FluxBackend;
  forceOcrCpu: boolean;
  isFluxBackendOptionDisabled: (backend: FluxBackend) => boolean;
  ocrDevice: OcrDevice;
  setFluxBackend: React.Dispatch<React.SetStateAction<FluxBackend>>;
  setOcrDevice: React.Dispatch<React.SetStateAction<OcrDevice>>;
  usesAmdHardware: boolean;
  usesNvidiaHardware: boolean;
};

export function HardwareSettingsPanel({
  clearTestState,
  controlsBusy,
  fluxBackend,
  forceOcrCpu,
  isFluxBackendOptionDisabled,
  ocrDevice,
  setFluxBackend,
  setOcrDevice,
  usesAmdHardware,
  usesNvidiaHardware,
}: HardwareSettingsPanelProps): React.JSX.Element {
  return (
    <>
      <div className="settings-field-stack">
        <span>Paddle OCR 장치</span>
        <div
          className="settings-mode-group"
          role="tablist"
          aria-label="Paddle OCR 장치"
        >
          {OCR_DEVICE_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`settings-preset-button ${ocrDevice === option.id ? "active" : ""}`}
              onClick={() => {
                clearTestState();
                setOcrDevice(option.id);
              }}
              disabled={controlsBusy || (forceOcrCpu && option.id === "gpu")}
              aria-pressed={ocrDevice === option.id}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="muted-line modal-note">
          {forceOcrCpu
            ? "AMD GPU 환경에서는 PaddleOCR GPU 경로를 쓰지 않고 OCR만 CPU로 처리합니다."
            : OCR_DEVICE_OPTIONS.find((option) => option.id === ocrDevice)
                ?.description}
        </p>
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
