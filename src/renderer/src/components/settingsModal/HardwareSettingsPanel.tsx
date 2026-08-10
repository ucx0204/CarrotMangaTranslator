import React from "react";
import { useTranslation } from "react-i18next";
import { OCR_DEVICE_OPTIONS, OCR_QUALITY_OPTIONS } from "../settingsOptions";
import { OcrHardwareContextNote } from "./HardwareContextNotes";
import { SettingsSection } from "./SettingsSection";
import { InpaintingModelSettings } from "./InpaintingModelSettings";
import { GpuAssignmentSettings } from "./GpuAssignmentSettings";
import { FluxBackendSettings } from "./FluxBackendSettings";
import { HardwareStatusSummary } from "./HardwareStatusSummary";
import type { HardwareSettingsPanelProps } from "./hardwareSettingsTypes";

export function HardwareSettingsPanel(
  props: HardwareSettingsPanelProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="settings-panel-stack">
      <HardwareStatusSummary {...props} />
      {!props.usesAppleHardware ? (
        <details className="settings-advanced hardware-advanced-settings">
          <summary>{t("settings.hardware.gpuAdvanced")}</summary>
          <GpuAssignmentSettings
            clearTestState={props.clearTestState}
            computeGpuIndex={props.computeGpuIndex}
            controlsBusy={props.controlsBusy}
            graphicsGpuPreference={props.graphicsGpuPreference}
            setComputeGpuIndex={props.setComputeGpuIndex}
            setGraphicsGpuPreference={props.setGraphicsGpuPreference}
          />
        </details>
      ) : null}
      <OcrSettingsSection {...props} />
      <InpaintingSettingsSection {...props} />
    </div>
  );
}

function OcrSettingsSection({
  clearTestState,
  controlsBusy,
  ocrDevice,
  ocrGpuBackend,
  ocrQualityMode,
  setOcrDevice,
  setOcrGpuBackend,
  setOcrQualityMode,
  usesAmdOcrContext,
  usesAppleHardware,
  usesNvidiaOcrContext,
}: HardwareSettingsPanelProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
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
        <details className="settings-advanced hardware-advanced-settings">
          <summary>{t("settings.hardware.ocrAdvanced")}</summary>
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
        </details>
      </div>
    </SettingsSection>
  );
}

function InpaintingSettingsSection({
  allowUnsafeLowMemoryFlux,
  clearTestState,
  controlsBusy,
  fluxBackend,
  inpaintingModel,
  isFluxBackendOptionDisabled,
  setAllowUnsafeLowMemoryFlux,
  setFluxBackend,
  setInpaintingModel,
  unifiedMemoryMb,
  usesAmdHardware,
  usesAppleHardware,
  usesNvidiaHardware,
}: HardwareSettingsPanelProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <SettingsSection title={t("settings.hardware.inpaintingSection")}>
      <div className="settings-subsection-stack">
        <InpaintingModelSettings
          allowUnsafeLowMemoryFlux={allowUnsafeLowMemoryFlux}
          clearTestState={clearTestState}
          controlsBusy={controlsBusy}
          inpaintingModel={inpaintingModel}
          setAllowUnsafeLowMemoryFlux={setAllowUnsafeLowMemoryFlux}
          setInpaintingModel={setInpaintingModel}
          unifiedMemoryMb={unifiedMemoryMb}
          usesAppleHardware={usesAppleHardware}
        />
        <details className="settings-advanced hardware-advanced-settings">
          <summary>{t("settings.hardware.inpaintingBackendAdvanced")}</summary>
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
        </details>
      </div>
    </SettingsSection>
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
  const visibleQualityOptions = OCR_QUALITY_OPTIONS.filter((option) => {
    if (usesAppleHardware && option.id === "full") {
      return false;
    }
    return true;
  });
  return (
    <div className="settings-field-stack">
      <span>{t("settings.hardware.ocrQuality")}</span>
      <div
        className="settings-preset-group settings-ocr-quality-group"
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
