import React from "react";
import { ControlTooltip } from "../ui/ControlTooltip";
import { useTranslation } from "react-i18next";
import { OCR_DEVICE_OPTIONS, OCR_QUALITY_OPTIONS } from "../settingsOptions";
import { SettingsSection } from "./SettingsSection";
import { GpuAssignmentSettings } from "./GpuAssignmentSettings";
import { FluxBackendSettings } from "./FluxBackendSettings";
import { HardwareStatusSummary } from "./HardwareStatusSummary";
import type { HardwareSettingsPanelProps } from "./hardwareSettingsTypes";

export function HardwareSettingsPanel(
  props: HardwareSettingsPanelProps,
): React.JSX.Element {
  return (
    <div className="settings-panel-stack">
      <HardwareStatusSummary {...props} />
      {!props.usesAppleHardware ? (
        <GpuAssignmentSettings
          clearTestState={props.clearTestState}
          computeGpuIndex={props.computeGpuIndex}
          controlsBusy={props.controlsBusy}
          graphicsGpuPreference={props.graphicsGpuPreference}
          setComputeGpuIndex={props.setComputeGpuIndex}
          setGraphicsGpuPreference={props.setGraphicsGpuPreference}
        />
      ) : null}
    </div>
  );
}

export function OcrSettingsSection({
  clearTestState,
  controlsBusy,
  ocrDevice,
  ocrGpuBackend,
  ocrPipeline,
  ocrQualityMode,
  setOcrDevice,
  setOcrGpuBackend,
  setOcrPipeline,
  setOcrQualityMode,
  supportsOcrRocm,
  usesAmdOcrContext,
  usesAppleHardware,
  usesNvidiaOcrContext,
}: HardwareSettingsPanelProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <SettingsSection title={t("settings.hardware.ocrSection")}>
      <div className="settings-subsection-stack">
        <OcrPipelineSettings
          clearTestState={clearTestState}
          controlsBusy={controlsBusy}
          ocrPipeline={ocrPipeline}
          setOcrPipeline={setOcrPipeline}
        />
        {ocrPipeline === "paddle-legacy" ? (
          <OcrQualitySettings
            clearTestState={clearTestState}
            controlsBusy={controlsBusy}
            ocrQualityMode={ocrQualityMode}
            setOcrDevice={setOcrDevice}
            setOcrGpuBackend={setOcrGpuBackend}
            setOcrQualityMode={setOcrQualityMode}
            supportsOcrRocm={supportsOcrRocm}
            usesAmdOcrContext={usesAmdOcrContext}
            usesAppleHardware={usesAppleHardware}
            usesNvidiaOcrContext={usesNvidiaOcrContext}
          />
        ) : null}
        <OcrDeviceSettings
          clearTestState={clearTestState}
          controlsBusy={controlsBusy}
          ocrDevice={ocrDevice}
          ocrGpuBackend={ocrGpuBackend}
          ocrPipeline={ocrPipeline}
          setOcrDevice={setOcrDevice}
          setOcrGpuBackend={setOcrGpuBackend}
          supportsOcrRocm={supportsOcrRocm}
          usesAmdOcrContext={usesAmdOcrContext}
          usesAppleHardware={usesAppleHardware}
          usesNvidiaOcrContext={usesNvidiaOcrContext}
        />
      </div>
    </SettingsSection>
  );
}

function OcrPipelineSettings({
  clearTestState,
  controlsBusy,
  ocrPipeline,
  setOcrPipeline,
}: Pick<HardwareSettingsPanelProps, "clearTestState" | "controlsBusy"> & {
  ocrPipeline: HardwareSettingsPanelProps["ocrPipeline"];
  setOcrPipeline: HardwareSettingsPanelProps["setOcrPipeline"];
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="settings-field-stack">
      <span>{t("settings.hardware.ocrPipeline")}</span>
      <div
        className="settings-preset-group"
        role="group"
        aria-label={t("settings.hardware.ocrPipeline")}
      >
        {(["hayai", "paddle-legacy"] as const).map((pipeline) => (
          <ControlTooltip
            floating
            content={t(
              `settings.hardware.ocrPipelines.${pipeline}.description`,
            )}
            key={pipeline}
          >
            <button
              key={pipeline}
              type="button"
              className={`settings-preset-button ${ocrPipeline === pipeline ? "active" : ""}`}
              disabled={controlsBusy}
              aria-pressed={ocrPipeline === pipeline}
              onClick={() => {
                clearTestState();
                setOcrPipeline(pipeline);
              }}
            >
              {t(`settings.hardware.ocrPipelines.${pipeline}.label`)}
            </button>
          </ControlTooltip>
        ))}
      </div>
    </div>
  );
}

export function InpaintingSettingsSection({
  clearTestState,
  controlsBusy,
  fluxBackend,
  inpaintingModel,
  isFluxBackendOptionDisabled,
  setFluxBackend,
  usesAmdHardware,
  usesAppleHardware,
  detectedGpuName,
  supportsFluxZluda,
}: HardwareSettingsPanelProps): React.JSX.Element {
  return (
    <div className="settings-subsection-stack">
      <FluxBackendSettings
        clearTestState={clearTestState}
        controlsBusy={controlsBusy}
        fluxBackend={fluxBackend}
        inpaintingModel={inpaintingModel}
        isFluxBackendOptionDisabled={isFluxBackendOptionDisabled}
        setFluxBackend={setFluxBackend}
        detectedGpuName={detectedGpuName}
        supportsFluxZluda={supportsFluxZluda}
        usesAmdHardware={usesAmdHardware}
        usesAppleHardware={usesAppleHardware}
      />
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
  supportsOcrRocm,
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
  | "supportsOcrRocm"
  | "usesAmdOcrContext"
  | "usesAppleHardware"
  | "usesNvidiaOcrContext"
>): React.JSX.Element {
  const { t } = useTranslation("components");

  const visibleQualityOptions = OCR_QUALITY_OPTIONS.filter((option) => {
    if (
      option.id === "full" &&
      (usesAppleHardware || (usesAmdOcrContext && supportsOcrRocm === false))
    ) {
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
          <ControlTooltip
            floating
            content={t(option.descriptionKey)}
            key={option.id}
          >
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
          </ControlTooltip>
        ))}
      </div>
    </div>
  );
}

type OcrDeviceSettingsProps = Pick<
  HardwareSettingsPanelProps,
  | "clearTestState"
  | "controlsBusy"
  | "ocrDevice"
  | "ocrGpuBackend"
  | "ocrPipeline"
  | "setOcrDevice"
  | "setOcrGpuBackend"
  | "supportsOcrRocm"
  | "usesAmdOcrContext"
  | "usesAppleHardware"
  | "usesNvidiaOcrContext"
>;

function OcrDeviceSettings({
  clearTestState,
  controlsBusy,
  ocrDevice,
  ocrGpuBackend,
  setOcrDevice,
  setOcrGpuBackend,
  supportsOcrRocm,
  usesAmdOcrContext,
  usesAppleHardware,
  usesNvidiaOcrContext,
}: OcrDeviceSettingsProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const activeOcrOptionId = ocrDevice === "cpu" ? "cpu" : ocrGpuBackend;
  const visibleOcrOptions = getVisibleOcrOptions(usesAppleHardware);
  return (
    <div className="settings-field-stack">
      <span>{t("settings.hardware.ocrDevice")}</span>
      <div
        className="settings-preset-group"
        role="group"
        aria-label={t("settings.hardware.ocrDevice")}
      >
        {visibleOcrOptions.map((option) => {
          const unsupported = isOcrOptionDisabled(
            option.id,
            false,
            usesAmdOcrContext,
            usesNvidiaOcrContext,
            supportsOcrRocm,
          );
          return (
            <div className="settings-field-stack" key={option.id}>
              <ControlTooltip
                floating
                content={t(
                  unsupported
                    ? option.id === "rocm-transformers" &&
                      supportsOcrRocm === false
                      ? "settings.hardware.ocrRequirements.unsupportedRocm"
                      : `settings.hardware.ocrRequirements.${option.id}`
                    : option.descriptionKey,
                )}
              >
                <button
                  type="button"
                  className={`settings-preset-button ${activeOcrOptionId === option.id ? "active" : ""}`}
                  onClick={() => {
                    clearTestState();
                    setOcrDevice(option.device);
                    if (option.gpuBackend) {
                      setOcrGpuBackend(option.gpuBackend);
                    }
                  }}
                  disabled={controlsBusy || unsupported}
                  aria-pressed={activeOcrOptionId === option.id}
                >
                  {t(option.labelKey)}
                </button>
              </ControlTooltip>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function getVisibleOcrOptions(usesAppleHardware: boolean) {
  return usesAppleHardware
    ? OCR_DEVICE_OPTIONS.filter((option) => option.id === "cpu")
    : OCR_DEVICE_OPTIONS;
}

function isOcrOptionDisabled(
  optionId: string,
  controlsBusy: boolean,
  usesAmdOcrContext: boolean,
  usesNvidiaOcrContext: boolean,
  supportsOcrRocm: boolean | undefined,
): boolean {
  return (
    controlsBusy ||
    (optionId === "cuda" && usesAmdOcrContext) ||
    (optionId === "rocm-transformers" &&
      (usesNvidiaOcrContext ||
        (usesAmdOcrContext && supportsOcrRocm === false)))
  );
}
