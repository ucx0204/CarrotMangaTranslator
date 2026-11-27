import React from "react";
import { ControlTooltip } from "../ui/ControlTooltip";
import { useTranslation } from "react-i18next";
import {
  INPAINTING_MODEL_OPTIONS,
  OCR_DEVICE_OPTIONS,
} from "../settingsOptions";
import { Button } from "../ui/Button";
import {
  resolveHardwareRecommendation,
  type HardwareRecommendation,
} from "./hardwareRecommendation";
import type { HardwareSettingsPanelProps } from "./hardwareSettingsTypes";

export function HardwareStatusSummary(
  props: HardwareSettingsPanelProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const recommendation = resolveHardwareRecommendation(props);
  const matches = hardwareRecommendationMatches(props, recommendation);
  const ocrOption = OCR_DEVICE_OPTIONS.find(
    (option) =>
      option.id === (props.ocrDevice === "cpu" ? "cpu" : props.ocrGpuBackend),
  );
  const modelOption = INPAINTING_MODEL_OPTIONS.find(
    (option) => option.id === props.inpaintingModel,
  );
  const modelLabel = modelOption
    ? t(modelOption.labelKey)
    : props.inpaintingModel;
  const computeRouteLabel =
    props.computeGpuIndex === null
      ? t("settings.hardware.computeRouteAuto")
      : t("settings.hardware.computeRouteManual", {
          index: props.computeGpuIndex,
        });
  const visibleMemoryMb = props.usesAppleHardware
    ? props.unifiedMemoryMb
    : props.gpuMemoryMb;
  return (
    <section
      className="hardware-summary"
      aria-label={t("settings.hardware.summaryTitle")}
    >
      <div className="hardware-summary-copy">
        <span>{t("settings.hardware.detectedTitle")}</span>
        <strong>
          {props.detectedGpuName || t("settings.hardware.detectedUnknown")}
        </strong>
        {props.intel && (
          <small>
            {t(
              props.intel.vulkan
                ? "settings.hardware.intelVulkan"
                : "settings.hardware.intelCpu",
            )}
          </small>
        )}
        {visibleMemoryMb ? (
          <small>
            {t("settings.hardware.memoryValue", {
              memory: formatMemoryGb(visibleMemoryMb),
            })}
          </small>
        ) : null}
      </div>
      <div className="hardware-route-grid">
        <div>
          <span>{t("settings.hardware.computeRoute")}</span>
          <strong>{computeRouteLabel}</strong>
        </div>
        <div>
          <span>{t("settings.hardware.ocrRoute")}</span>
          <strong>{ocrOption ? t(ocrOption.labelKey) : props.ocrDevice}</strong>
        </div>
        <div>
          <span>{t("settings.hardware.inpaintingRoute")}</span>
          <strong>{modelLabel}</strong>
        </div>
      </div>
      <HardwareRecommendationAction
        props={props}
        matches={matches}
        recommendation={recommendation}
      />
    </section>
  );
}

function hardwareRecommendationMatches(
  props: HardwareSettingsPanelProps,
  recommendation: HardwareRecommendation,
): boolean {
  return (
    props.computeGpuIndex === null &&
    props.graphicsGpuPreference === recommendation.graphicsGpuPreference &&
    props.ocrDevice === recommendation.ocrDevice &&
    props.ocrGpuBackend === recommendation.ocrGpuBackend &&
    props.ocrQualityMode === recommendation.ocrQualityMode &&
    props.inpaintingModel === recommendation.inpaintingModel &&
    (props.inpaintingModel !== "qwen-image-2.1" ||
      props.fluxBackend === recommendation.fluxBackend) &&
    (props.inpaintingModel !== "flux-klein" ||
      (props.fluxBackend === recommendation.fluxBackend &&
        props.fluxMode === recommendation.fluxMode))
  );
}

function applyHardwareRecommendation(
  props: HardwareSettingsPanelProps,
  recommendation: HardwareRecommendation,
): void {
  props.clearTestState();
  props.setGraphicsGpuPreference(recommendation.graphicsGpuPreference);
  props.setComputeGpuIndex(null);
  props.setOcrDevice(recommendation.ocrDevice);
  props.setOcrGpuBackend(recommendation.ocrGpuBackend);
  props.setOcrQualityMode(recommendation.ocrQualityMode);
  props.setInpaintingModel(recommendation.inpaintingModel);
  props.setFluxBackend(recommendation.fluxBackend);
  props.setFluxMode(recommendation.fluxMode);
  props.setAllowUnsafeLowMemoryFlux(false);
}

function formatMemoryGb(memoryMb: number): string {
  return `${Math.round((memoryMb / 1024) * 10) / 10} GB`;
}

function HardwareRecommendationAction({
  props,
  matches,
  recommendation,
}: {
  props: HardwareSettingsPanelProps;
  matches: boolean;
  recommendation: HardwareRecommendation;
}) {
  const { t } = useTranslation("components");
  const [applying, setApplying] = React.useState(false);
  const [error, setError] = React.useState(false);
  return (
    <>
      <div className="hardware-recommendation-row">
        <ControlTooltip
          floating
          content={`${t(matches ? "settings.hardware.recommendedMatch" : "settings.hardware.recommendedDifferent")} ${t("settings.hardware.resetGemmaHint")}`}
        >
          <Button
            size="sm"
            onClick={() => {
              setApplying(true);
              setError(false);
              void (props.onApplyGemmaDefaults?.() ?? Promise.resolve())
                .then(() => applyHardwareRecommendation(props, recommendation))
                .catch((cause: unknown) => {
                  console.error("Hardware recommendation failed", cause);
                  setError(true);
                })
                .finally(() => setApplying(false));
            }}
            disabled={props.controlsBusy || applying}
          >
            {t("settings.hardware.applyRecommended")}
          </Button>
        </ControlTooltip>
      </div>
      {error && <p role="alert">{t("settings.hardware.resetFailed")}</p>}
    </>
  );
}
