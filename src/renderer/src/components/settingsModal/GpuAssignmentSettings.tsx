import React from "react";
import { useTranslation } from "react-i18next";
import {
  MAX_COMPUTE_GPU_INDEX,
  type GraphicsGpuPreference,
} from "../../../../shared/gpuSettings";
import { SettingsSection } from "./SettingsSection";

export type GpuAssignmentSettingsProps = {
  clearTestState: () => void;
  computeGpuIndex: number | null;
  controlsBusy: boolean;
  graphicsGpuPreference: GraphicsGpuPreference;
  setComputeGpuIndex: React.Dispatch<React.SetStateAction<number | null>>;
  setGraphicsGpuPreference: React.Dispatch<
    React.SetStateAction<GraphicsGpuPreference>
  >;
};

const COMPUTE_GPU_INDEX_OPTIONS = Array.from(
  { length: MAX_COMPUTE_GPU_INDEX + 1 },
  (_value, index) => index,
);

export function GpuAssignmentSettings({
  clearTestState,
  computeGpuIndex,
  controlsBusy,
  graphicsGpuPreference,
  setComputeGpuIndex,
  setGraphicsGpuPreference,
}: GpuAssignmentSettingsProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <SettingsSection
      title={t("settings.hardware.gpuSection")}
      description={t("settings.hardware.gpuSectionDescription")}
    >
      <div className="settings-subsection-stack">
        <label className="settings-field-stack">
          <span>{t("settings.hardware.graphicsGpu")}</span>
          <select
            aria-label={t("settings.hardware.graphicsGpu")}
            value={graphicsGpuPreference}
            disabled={controlsBusy}
            onChange={(event) => {
              clearTestState();
              setGraphicsGpuPreference(
                event.target.value as GraphicsGpuPreference,
              );
            }}
          >
            <option value="auto">
              {t("settings.hardware.graphicsGpuAuto")}
            </option>
            <option value="high-performance">
              {t("settings.hardware.graphicsGpuHighPerformance")}
            </option>
          </select>
        </label>
        <label className="settings-field-stack">
          <span>{t("settings.hardware.computeGpu")}</span>
          <select
            aria-label={t("settings.hardware.computeGpu")}
            value={computeGpuIndex ?? ""}
            disabled={controlsBusy}
            onChange={(event) => {
              clearTestState();
              setComputeGpuIndex(
                event.target.value === "" ? null : Number(event.target.value),
              );
            }}
          >
            <option value="">{t("settings.hardware.computeGpuAuto")}</option>
            {COMPUTE_GPU_INDEX_OPTIONS.map((index) => (
              <option key={index} value={index}>
                {t("settings.hardware.computeGpuOption", { index })}
              </option>
            ))}
          </select>
        </label>
        <p className="muted-line modal-note">
          {t("settings.hardware.gpuNumberingNote")}
        </p>
        <p className="muted-line modal-note settings-gpu-restart-note">
          {t("settings.hardware.graphicsGpuRestartNote")}
        </p>
      </div>
    </SettingsSection>
  );
}
