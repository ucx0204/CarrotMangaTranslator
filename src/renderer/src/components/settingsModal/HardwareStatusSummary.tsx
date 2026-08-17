import React from "react";
import { useTranslation } from "react-i18next";
import type { InpaintingModel } from "../../../../shared/settingsTypes";
import { OCR_DEVICE_OPTIONS } from "../settingsOptions";
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
  const modelLabel = t(
    `settings.options.inpaintingModels.${resolveInpaintingModelKey(props.inpaintingModel)}.label`,
  );
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
      <div className="hardware-recommendation-row">
        <span className={matches ? "matches" : "different"}>
          {t(
            matches
              ? "settings.hardware.recommendedMatch"
              : "settings.hardware.recommendedDifferent",
          )}
        </span>
        {!matches ? (
          <Button
            size="sm"
            onClick={() => applyHardwareRecommendation(props, recommendation)}
            disabled={props.controlsBusy}
          >
            {t("settings.hardware.applyRecommended")}
          </Button>
        ) : null}
      </div>
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
    (props.inpaintingModel !== "flux-klein" ||
      props.fluxBackend === recommendation.fluxBackend)
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
  props.setAllowUnsafeLowMemoryFlux(false);
}

function resolveInpaintingModelKey(
  model: InpaintingModel,
): "aot" | "lama" | "flux" {
  if (model === "aot-inpainting") return "aot";
  if (model === "lama-manga") return "lama";
  return "flux";
}

function formatMemoryGb(memoryMb: number): string {
  return `${Math.round((memoryMb / 1024) * 10) / 10} GB`;
}
