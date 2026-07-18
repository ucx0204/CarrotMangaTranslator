import React from "react";
import { useTranslation } from "react-i18next";
import type {
  FluxBackend,
  InpaintingModel,
  OcrDevice,
  OcrGpuBackend,
  OcrQualityMode,
} from "../../../../shared/settingsTypes";
import {
  FLUX_BACKEND_OPTIONS,
  OCR_DEVICE_OPTIONS,
  OCR_QUALITY_OPTIONS,
} from "../settingsOptions";
import {
  AmdHipSdkDownloadButton,
  FluxHardwareContextNote,
  OcrHardwareContextNote,
} from "./HardwareContextNotes";
import { SettingsSection } from "./SettingsSection";
import { InpaintingModelSettings } from "./InpaintingModelSettings";

type HardwareSettingsPanelProps = {
  allowUnsafeLowMemoryFlux: boolean;
  clearTestState: () => void;
  controlsBusy: boolean;
  fluxBackend: FluxBackend;
  inpaintingModel: InpaintingModel;
  isFluxBackendOptionDisabled: (backend: FluxBackend) => boolean;
  ocrGpuBackend: OcrGpuBackend;
  ocrDevice: OcrDevice;
  ocrQualityMode: OcrQualityMode;
  setFluxBackend: React.Dispatch<React.SetStateAction<FluxBackend>>;
  setAllowUnsafeLowMemoryFlux: React.Dispatch<React.SetStateAction<boolean>>;
  setInpaintingModel: React.Dispatch<React.SetStateAction<InpaintingModel>>;
  setOcrDevice: React.Dispatch<React.SetStateAction<OcrDevice>>;
  setOcrGpuBackend: React.Dispatch<React.SetStateAction<OcrGpuBackend>>;
  setOcrQualityMode: React.Dispatch<React.SetStateAction<OcrQualityMode>>;
  usesAmdHardware: boolean;
  usesAppleHardware: boolean;
  usesAmdOcrContext: boolean;
  usesNvidiaHardware: boolean;
  usesNvidiaOcrContext: boolean;
  unifiedMemoryMb: number | null;
};

export function HardwareSettingsPanel({
  allowUnsafeLowMemoryFlux,
  clearTestState,
  controlsBusy,
  fluxBackend,
  inpaintingModel,
  isFluxBackendOptionDisabled,
  ocrGpuBackend,
  ocrDevice,
  ocrQualityMode,
  setFluxBackend,
  setAllowUnsafeLowMemoryFlux,
  setInpaintingModel,
  setOcrDevice,
  setOcrGpuBackend,
  setOcrQualityMode,
  usesAmdHardware,
  usesAppleHardware,
  usesAmdOcrContext,
  usesNvidiaHardware,
  usesNvidiaOcrContext,
  unifiedMemoryMb,
}: HardwareSettingsPanelProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="settings-panel-stack">
      <SettingsSection title={t("settings.hardware.ocrSection")}>
        <div className="settings-subsection-stack">
          <OcrQualitySettings
            clearTestState={clearTestState}
            controlsBusy={controlsBusy}
            ocrQualityMode={ocrQualityMode}
            setOcrDevice={setOcrDevice}
            setOcrGpuBackend={setOcrGpuBackend}
            setOcrQualityMode={setOcrQualityMode}
            usesAmdOcrContext={usesAmdOcrContext}
            usesAppleHardware={usesAppleHardware}
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
            usesAppleHardware={usesAppleHardware}
            usesNvidiaOcrContext={usesNvidiaOcrContext}
          />
        </div>
      </SettingsSection>
      <SettingsSection title={t("settings.hardware.inpaintingSection")}>
        <div className="settings-subsection-stack">
          <InpaintingModelSettings
            clearTestState={clearTestState}
            controlsBusy={controlsBusy}
            inpaintingModel={inpaintingModel}
            allowUnsafeLowMemoryFlux={allowUnsafeLowMemoryFlux}
            setInpaintingModel={setInpaintingModel}
            setAllowUnsafeLowMemoryFlux={setAllowUnsafeLowMemoryFlux}
            unifiedMemoryMb={unifiedMemoryMb}
            usesAppleHardware={usesAppleHardware}
          />
          <FluxBackendSettings
            clearTestState={clearTestState}
            controlsBusy={controlsBusy}
            fluxBackend={fluxBackend}
            inpaintingModel={inpaintingModel}
            isFluxBackendOptionDisabled={isFluxBackendOptionDisabled}
            setFluxBackend={setFluxBackend}
            usesAmdHardware={usesAmdHardware}
            usesAppleHardware={usesAppleHardware}
            usesNvidiaHardware={usesNvidiaHardware}
          />
        </div>
      </SettingsSection>
    </div>
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
  usesAppleHardware,
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
  | "usesAppleHardware"
  | "usesNvidiaOcrContext"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  const activeOption = OCR_QUALITY_OPTIONS.find(
    (option) => option.id === ocrQualityMode,
  );
  const visibleQualityOptions = usesAppleHardware
    ? OCR_QUALITY_OPTIONS.filter((option) => option.id !== "full")
    : OCR_QUALITY_OPTIONS;
  return (
    <div className="settings-field-stack">
      <span>{t("settings.hardware.ocrQuality")}</span>
      <div
        className="settings-preset-group"
        role="group"
        aria-label={t("settings.hardware.ocrQuality")}
      >
        {visibleQualityOptions.map((option) => (
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
            {t(option.labelKey)}
          </button>
        ))}
      </div>
      <p className="muted-line modal-note">
        {activeOption ? t(activeOption.descriptionKey) : null}
      </p>
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
  usesAppleHardware,
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
  | "usesAppleHardware"
  | "usesNvidiaOcrContext"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  const activeOcrOptionId = ocrDevice === "cpu" ? "cpu" : ocrGpuBackend;
  const activeOcrOption = OCR_DEVICE_OPTIONS.find(
    (option) => option.id === activeOcrOptionId,
  );
  const visibleOcrOptions = usesAppleHardware
    ? OCR_DEVICE_OPTIONS.filter((option) => option.id === "cpu")
    : OCR_DEVICE_OPTIONS;
  const ocrDescription =
    usesAmdOcrContext && activeOcrOptionId === "rocm-transformers"
      ? t("settings.hardware.amdOcrExperimental")
      : activeOcrOption
        ? t(activeOcrOption.descriptionKey)
        : null;

  return (
    <div className="settings-field-stack">
      <span>{t("settings.hardware.ocrDevice")}</span>
      <div
        className="settings-preset-group"
        role="group"
        aria-label={t("settings.hardware.ocrDevice")}
      >
        {visibleOcrOptions.map((option) => (
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
            {t(option.labelKey)}
          </button>
        ))}
      </div>
      <p className="muted-line modal-note">{ocrDescription}</p>
      <OcrHardwareContextNote
        usesAmdOcrContext={usesAmdOcrContext}
        usesAppleHardware={usesAppleHardware}
        usesNvidiaOcrContext={usesNvidiaOcrContext}
      />
    </div>
  );
}

function FluxBackendSettings({
  clearTestState,
  controlsBusy,
  fluxBackend,
  inpaintingModel,
  isFluxBackendOptionDisabled,
  setFluxBackend,
  usesAmdHardware,
  usesAppleHardware,
  usesNvidiaHardware,
}: Pick<
  HardwareSettingsPanelProps,
  | "clearTestState"
  | "controlsBusy"
  | "fluxBackend"
  | "inpaintingModel"
  | "isFluxBackendOptionDisabled"
  | "setFluxBackend"
  | "usesAmdHardware"
  | "usesAppleHardware"
  | "usesNvidiaHardware"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  const activeFluxBackend = FLUX_BACKEND_OPTIONS.find(
    (option) => option.id === fluxBackend,
  );
  const visibleFluxBackends = usesAppleHardware
    ? FLUX_BACKEND_OPTIONS.filter((option) => option.id === "metal-native")
    : FLUX_BACKEND_OPTIONS.filter((option) => option.id !== "metal-native");
  return (
    <div className="settings-field-stack">
      <span>{t("settings.hardware.fluxBackend")}</span>
      <div
        className="settings-preset-group"
        role="group"
        aria-label={t("settings.hardware.fluxBackend")}
      >
        {visibleFluxBackends.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`settings-preset-button ${fluxBackend === option.id ? "active" : ""}`}
            onClick={() => {
              clearTestState();
              setFluxBackend(option.id);
            }}
            disabled={controlsBusy || isFluxBackendOptionDisabled(option.id)}
            aria-pressed={fluxBackend === option.id}
          >
            {t(option.labelKey)}
          </button>
        ))}
      </div>
      <p className="muted-line modal-note">
        {inpaintingModel === "flux-klein"
          ? activeFluxBackend
            ? t(activeFluxBackend.descriptionKey)
            : null
          : t("settings.hardware.fluxOnlyNote")}
      </p>
      {inpaintingModel === "flux-klein" && fluxBackend === "zluda-native" ? (
        <AmdHipSdkDownloadButton />
      ) : null}
      <FluxHardwareContextNote
        usesAmdHardware={usesAmdHardware}
        usesAppleHardware={usesAppleHardware}
        usesNvidiaHardware={usesNvidiaHardware}
      />
    </div>
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
