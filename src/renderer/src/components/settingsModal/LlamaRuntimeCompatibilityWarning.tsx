import React from "react";
import { useTranslation } from "react-i18next";
import type { LlamaRuntimeProfile } from "../../../../shared/settingsTypes";
import { resolveLlamaRuntimeCompatibilityWarning } from "./llamaRuntimeCompatibility";

export function LlamaRuntimeCompatibilityWarning({
  detectedGpuName,
  llamaRuntimeProfile,
  usesNvidiaHardware,
  usesRtx50Hardware,
}: {
  detectedGpuName?: string | null;
  llamaRuntimeProfile: LlamaRuntimeProfile;
  usesNvidiaHardware: boolean;
  usesRtx50Hardware: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  const warning = resolveLlamaRuntimeCompatibilityWarning({
    llamaRuntimeProfile,
    usesNvidiaHardware,
    usesRtx50Hardware,
  });
  if (!warning) return null;
  return (
    <div className="hardware-runtime-warning" role="alert">
      <strong>{t("settings.gemma.runtime.mismatchTitle")}</strong>
      <span>
        {t(
          warning === "rtx50-using-cuda12"
            ? "settings.gemma.runtime.rtx50UsingCuda12Warning"
            : "settings.gemma.runtime.nonRtx50UsingRtx50Warning",
          {
            gpu: detectedGpuName || t("settings.hardware.detectedUnknown"),
          },
        )}
      </span>
    </div>
  );
}
