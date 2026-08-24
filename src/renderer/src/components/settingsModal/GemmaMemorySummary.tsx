import React from "react";
import { useTranslation } from "react-i18next";
import {
  evaluateGemmaUnifiedMemory,
  GEMMA_MODEL_DOWNLOAD_BYTES,
} from "../../../../shared/gemmaMemoryPolicy";
import { MODEL_PRESETS, type ModelPresetId } from "../settingsOptions";
import { Select } from "../ui/Select";
import { formatDownloadGb, formatMemoryGb } from "./gemmaMemoryRisk";
import type { EngineSettingsPanelProps } from "./EngineSettingsPanelTypes";

const FIT_TARGET_MB_OPTIONS = [512, 1024, 1536, 2048, 3072, 4096] as const;

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
  const hasCustomFitTarget = !FIT_TARGET_MB_OPTIONS.some(
    (candidate) => candidate === gemmaFitTargetMb,
  );
  const fitTargetOptions = [
    ...(hasCustomFitTarget ? [gemmaFitTargetMb] : []),
    ...FIT_TARGET_MB_OPTIONS,
  ].map((value) => ({
    value: String(value),
    label: t("settings.gemma.vramTuning.reserveOption", { value }),
  }));
  return (
    <div className="settings-field-stack">
      <span>{t("settings.gemma.vramTuning.reserveLabel")}</span>
      <Select
        value={String(gemmaFitTargetMb)}
        disabled={controlsBusy}
        ariaLabel={t("settings.gemma.vramTuning.reserveLabel")}
        options={fitTargetOptions}
        onValueChange={(value) => {
          clearTestState();
          setGemmaFitTargetMb(Number(value));
        }}
      />
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
