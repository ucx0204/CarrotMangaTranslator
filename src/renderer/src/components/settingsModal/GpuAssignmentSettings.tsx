import React from "react";
import { useTranslation } from "react-i18next";
import {
  MAX_COMPUTE_GPU_INDEX,
  type GraphicsGpuPreference,
} from "../../../../shared/gpuSettings";
import { SettingsSection } from "./SettingsSection";
import { Select } from "../ui/Select";

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
    <SettingsSection title={t("settings.hardware.gpuSection")}>
      <div className="settings-subsection-stack">
        <label className="settings-field-stack">
          <span>{t("settings.hardware.graphicsGpu")}</span>
          <Select
            ariaLabel={t("settings.hardware.graphicsGpu")}
            value={graphicsGpuPreference}
            disabled={controlsBusy}
            options={[
              {
                value: "auto",
                label: t("settings.hardware.graphicsGpuAuto"),
              },
              {
                value: "high-performance",
                label: t("settings.hardware.graphicsGpuHighPerformance"),
              },
            ]}
            onValueChange={(nextValue) => {
              clearTestState();
              setGraphicsGpuPreference(nextValue as GraphicsGpuPreference);
            }}
          />
        </label>
        <label className="settings-field-stack">
          <span>{t("settings.hardware.computeGpu")}</span>
          <Select
            ariaLabel={t("settings.hardware.computeGpu")}
            value={computeGpuIndex === null ? "" : String(computeGpuIndex)}
            disabled={controlsBusy}
            options={[
              { value: "", label: t("settings.hardware.computeGpuAuto") },
              ...COMPUTE_GPU_INDEX_OPTIONS.map((index) => ({
                value: String(index),
                label: t("settings.hardware.computeGpuOption", { index }),
              })),
            ]}
            onValueChange={(nextValue) => {
              clearTestState();
              setComputeGpuIndex(nextValue === "" ? null : Number(nextValue));
            }}
          />
        </label>
        <p className="muted-line modal-note settings-gpu-restart-note">
          {t("settings.hardware.graphicsGpuRestartNote")}
        </p>
      </div>
    </SettingsSection>
  );
}
