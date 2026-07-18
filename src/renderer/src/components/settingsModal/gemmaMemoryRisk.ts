import type { TFunction } from "i18next";
import {
  evaluateGemmaUnifiedMemory,
  GEMMA_MODEL_DOWNLOAD_BYTES,
} from "../../../../shared/gemmaMemoryPolicy";
import { MODEL_PRESETS, type ModelPresetId } from "../settingsOptions";

type GemmaMemoryGuardProps = {
  allowUnsafeUnifiedMemory: boolean;
  setAllowUnsafeUnifiedMemory: (value: boolean) => void;
  unifiedMemoryMb: number | null;
  usesAppleHardware: boolean;
};

export function confirmGemmaMemoryRisk(
  presetId: ModelPresetId,
  props: GemmaMemoryGuardProps,
  t: TFunction<"components">,
): boolean {
  if (presetId === "custom" || !props.usesAppleHardware) return true;
  const mode = MODEL_PRESETS[presetId].vramMode;
  const evaluation = evaluateGemmaUnifiedMemory(
    mode,
    props.unifiedMemoryMb ?? 0,
    props.allowUnsafeUnifiedMemory,
  );
  if (!evaluation.requiresExplicitAlphaConfirmation) {
    props.setAllowUnsafeUnifiedMemory(false);
    return true;
  }
  if (props.allowUnsafeUnifiedMemory) return true;
  const confirmed = window.confirm(
    t("settings.gemma.memory.unsafeConfirm", {
      available: formatMemoryGb(evaluation.availableMemoryMb),
      download: formatDownloadGb(GEMMA_MODEL_DOWNLOAD_BYTES[mode]),
      required: formatMemoryGb(evaluation.requiredMemoryMb),
    }),
  );
  if (confirmed) props.setAllowUnsafeUnifiedMemory(true);
  return confirmed;
}

export function formatMemoryGb(memoryMb: number): string {
  return `${Math.round((memoryMb / 1024) * 10) / 10} GB`;
}

export function formatDownloadGb(bytes: number): string {
  return `${Math.round((bytes / 1_000_000_000) * 100) / 100} GB`;
}
