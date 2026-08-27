import React from "react";
import { useTranslation } from "react-i18next";
import {
  GEMMA_DEDICATED_VRAM_REQUIREMENTS_MB,
  meetsGemmaDedicatedVramRequirement,
} from "../../../../shared/gemmaMemoryPolicy";
import { MODEL_PRESETS, type ModelPresetId } from "../settingsOptions";
import { formatMemoryGb } from "./gemmaMemoryRisk";

export function GemmaVramWarning({
  gpuMemoryMb,
  selectedPreset,
}: {
  gpuMemoryMb: number | null;
  selectedPreset: Exclude<ModelPresetId, "custom">;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  const requiredMemoryMb =
    GEMMA_DEDICATED_VRAM_REQUIREMENTS_MB[
      MODEL_PRESETS[selectedPreset].vramMode
    ];
  if (
    !gpuMemoryMb ||
    meetsGemmaDedicatedVramRequirement(
      MODEL_PRESETS[selectedPreset].vramMode,
      gpuMemoryMb,
    )
  ) {
    return null;
  }
  return (
    <div className="hardware-runtime-warning" role="status">
      <strong>{t("settings.gemma.memory.vramInsufficientTitle")}</strong>
      <span>
        {t("settings.gemma.memory.vramInsufficientDescription", {
          available: formatMemoryGb(gpuMemoryMb),
          required: formatMemoryGb(requiredMemoryMb),
        })}
      </span>
    </div>
  );
}
