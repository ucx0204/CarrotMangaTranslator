import { InpaintingSettingsSection } from "./HardwareSettingsPanel";
import { ImageRedactionSettings } from "../ImageRedactionSettings";
import type React from "react";
import { useTranslation } from "react-i18next";
import { CodexSettingsFields } from "./CodexSettingsFields";
import type { EngineSettingsPanelProps } from "./EngineSettingsPanelTypes";
import type { HardwareSettingsPanelProps } from "./hardwareSettingsTypes";
import { InpaintingModelSettings } from "./InpaintingModelSettings";
import { SettingsSection } from "./SettingsSection";

export function ImageSettingsPanel({
  engine,
  hardware,
}: {
  engine: EngineSettingsPanelProps;
  hardware: HardwareSettingsPanelProps;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="settings-panel-stack">
      <SettingsSection title={t("settings.image.localErasure")}>
        <InpaintingModelSettings {...hardware} />
        <InpaintingSettingsSection {...hardware} />
      </SettingsSection>
      <SettingsSection
        title={t("settings.image.codex")}
        description={t("settings.image.description")}
      >
        <CodexSettingsFields {...engine} imageOnly />
      </SettingsSection>
      <ImageRedactionSettings />
    </div>
  );
}
