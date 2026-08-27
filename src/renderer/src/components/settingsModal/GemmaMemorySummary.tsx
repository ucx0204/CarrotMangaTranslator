import React from "react";
import { useTranslation } from "react-i18next";
import {
  evaluateGemmaUnifiedMemory,
  GEMMA_MODEL_DOWNLOAD_BYTES,
} from "../../../../shared/gemmaMemoryPolicy";
import { MODEL_PRESETS, type ModelPresetId } from "../settingsOptions";
import { formatDownloadGb, formatMemoryGb } from "./gemmaMemoryRisk";
import type { EngineSettingsPanelProps } from "./EngineSettingsPanelTypes";

const FIT_TARGET_INCREMENT_MB = [128, 256, 512] as const;
const MAX_FIT_TARGET_MB = 16_384;

type GemmaVramTuningProps = Pick<
  EngineSettingsPanelProps,
  | "clearTestState"
  | "controlsBusy"
  | "gemmaFitTargetMb"
  | "gemmaMmprojOffload"
  | "setGemmaFitTargetMb"
  | "setGemmaMmprojOffload"
>;

export function GemmaVramTuningFields(
  props: GemmaVramTuningProps,
): React.JSX.Element {
  return (
    <>
      <GemmaFitTargetField {...props} />
      <GemmaMmprojField {...props} />
    </>
  );
}

function GemmaFitTargetField({
  clearTestState,
  controlsBusy,
  gemmaFitTargetMb,
  setGemmaFitTargetMb,
}: GemmaVramTuningProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const updateFitTarget = (value: number): void => {
    if (!Number.isInteger(value) || value < 0 || value > MAX_FIT_TARGET_MB) {
      return;
    }
    clearTestState();
    setGemmaFitTargetMb(value);
  };
  return (
    <div className="settings-field-stack">
      <span>{t("settings.gemma.vramTuning.reserveLabel")}</span>
      <div className="gemma-fit-target-controls">
        <label className="gemma-fit-target-input">
          <input
            type="number"
            min={0}
            max={MAX_FIT_TARGET_MB}
            step={1}
            inputMode="numeric"
            value={gemmaFitTargetMb}
            disabled={controlsBusy}
            aria-label={t("settings.gemma.vramTuning.reserveInputAria")}
            onChange={(event) =>
              updateFitTarget(event.currentTarget.valueAsNumber)
            }
          />
          <span aria-hidden="true">MiB</span>
        </label>
        {FIT_TARGET_INCREMENT_MB.map((increment) => (
          <button
            key={increment}
            type="button"
            className="settings-preset-button gemma-fit-target-increment"
            disabled={controlsBusy || gemmaFitTargetMb >= MAX_FIT_TARGET_MB}
            aria-label={t("settings.gemma.vramTuning.reserveAddAria", {
              value: increment,
            })}
            onClick={() =>
              updateFitTarget(
                Math.min(MAX_FIT_TARGET_MB, gemmaFitTargetMb + increment),
              )
            }
          >
            +{increment} MiB
          </button>
        ))}
      </div>
      <p className="muted-line modal-note">
        {t("settings.gemma.vramTuning.reserveDescription")}
      </p>
    </div>
  );
}

function GemmaMmprojField({
  clearTestState,
  controlsBusy,
  gemmaMmprojOffload,
  setGemmaMmprojOffload,
}: GemmaVramTuningProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="settings-field-stack">
      <span>{t("settings.gemma.vramTuning.mmprojLabel")}</span>
      <div
        className="settings-mode-group"
        role="group"
        aria-label={t("settings.gemma.vramTuning.mmprojLabel")}
      >
        <button
          type="button"
          className={`settings-preset-button ${gemmaMmprojOffload ? "active" : ""}`}
          disabled={controlsBusy}
          aria-pressed={gemmaMmprojOffload}
          onClick={() => {
            clearTestState();
            setGemmaMmprojOffload(true);
          }}
        >
          {t("settings.gemma.vramTuning.mmprojGpu")}
        </button>
        <button
          type="button"
          className={`settings-preset-button ${gemmaMmprojOffload ? "" : "active"}`}
          disabled={controlsBusy}
          aria-pressed={!gemmaMmprojOffload}
          onClick={() => {
            clearTestState();
            setGemmaMmprojOffload(false);
          }}
        >
          {t("settings.gemma.vramTuning.mmprojCpu")}
        </button>
      </div>
      <p className="muted-line modal-note">
        {t(
          gemmaMmprojOffload
            ? "settings.gemma.vramTuning.mmprojGpuDescription"
            : "settings.gemma.vramTuning.mmprojCpuDescription",
        )}
      </p>
    </div>
  );
}

export function RuntimeHardwareNote({
  usesAmdHardware,
  usesAppleHardware,
  usesNvidiaHardware,
}: {
  usesAmdHardware: boolean;
  usesAppleHardware: boolean;
  usesNvidiaHardware: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  const messageKey = usesAppleHardware
    ? "settings.gemma.runtime.appleNote"
    : usesAmdHardware
      ? "settings.gemma.runtime.amdNote"
      : usesNvidiaHardware
        ? "settings.gemma.runtime.nvidiaNote"
        : null;
  return messageKey ? (
    <p className="muted-line modal-note">{t(messageKey)}</p>
  ) : null;
}

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
