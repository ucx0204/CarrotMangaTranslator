import React from "react";
import { useTranslation } from "react-i18next";
import type { BubbleDetectionMode } from "../../../../shared/settingsTypes";

export function BubbleDetectionSettings({
  bubbleDetectionMode,
  clearTestState,
  controlsBusy,
  setBubbleDetectionMode,
  usesNvidiaHardware,
}: {
  bubbleDetectionMode: BubbleDetectionMode;
  clearTestState: () => void;
  controlsBusy: boolean;
  setBubbleDetectionMode: React.Dispatch<
    React.SetStateAction<BubbleDetectionMode>
  >;
  usesNvidiaHardware: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const options: BubbleDetectionMode[] = [
    "auto",
    "precise",
    "quality",
    "sam3-experimental",
  ];
  return (
    <div className="settings-field-stack">
      <span>{t("settings.hardware.bubbleDetection")}</span>
      <div
        className="settings-preset-group"
        role="group"
        aria-label={t("settings.hardware.bubbleDetection")}
      >
        {options.map((option) => (
          <button
            key={option}
            type="button"
            className={`settings-preset-button ${bubbleDetectionMode === option ? "active" : ""}`}
            disabled={
              controlsBusy ||
              (option === "sam3-experimental" && !usesNvidiaHardware)
            }
            aria-pressed={bubbleDetectionMode === option}
            onClick={() => {
              clearTestState();
              setBubbleDetectionMode(option);
            }}
          >
            {t(`settings.hardware.bubbleDetectionModes.${option}.label`)}
          </button>
        ))}
      </div>
      <p className="muted-line modal-note">
        {t(
          `settings.hardware.bubbleDetectionModes.${bubbleDetectionMode}.description`,
        )}
      </p>
    </div>
  );
}
