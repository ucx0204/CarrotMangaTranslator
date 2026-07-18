import React from "react";
import { useTranslation } from "react-i18next";
import {
  evaluateGemmaUnifiedMemory,
  GEMMA_MODEL_DOWNLOAD_BYTES,
} from "../../../../shared/gemmaMemoryPolicy";
import { MODEL_PRESETS, type ModelPresetId } from "../settingsOptions";
import { formatDownloadGb, formatMemoryGb } from "./gemmaMemoryRisk";

export function GemmaMemorySummary({
  allowUnsafeUnifiedMemory,
  selectedPreset,
  unifiedMemoryMb,
}: {
  allowUnsafeUnifiedMemory: boolean;
  selectedPreset: Exclude<ModelPresetId, "custom">;
  unifiedMemoryMb: number | null;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const mode = MODEL_PRESETS[selectedPreset].vramMode;
  const evaluation = evaluateGemmaUnifiedMemory(
    mode,
    unifiedMemoryMb ?? 0,
    allowUnsafeUnifiedMemory,
  );
  return (
    <div
      className={`mac-alpha-memory-summary ${evaluation.requiresExplicitAlphaConfirmation ? "warning" : "safe"}`}
      role="status"
    >
      <span>
        {t("settings.gemma.memory.summary", {
          available: formatMemoryGb(evaluation.availableMemoryMb),
          download: formatDownloadGb(GEMMA_MODEL_DOWNLOAD_BYTES[mode]),
          required: formatMemoryGb(evaluation.requiredMemoryMb),
        })}
      </span>
      {evaluation.requiresExplicitAlphaConfirmation ? (
        <strong>
          {t(
            allowUnsafeUnifiedMemory
              ? "settings.gemma.memory.unsafeAllowed"
              : "settings.gemma.memory.insufficient",
            { shortage: formatMemoryGb(evaluation.shortageMb) },
          )}
        </strong>
      ) : (
        <strong>{t("settings.gemma.memory.sufficient")}</strong>
      )}
    </div>
  );
}
