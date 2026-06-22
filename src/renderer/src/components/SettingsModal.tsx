import React from "react";
import type { AppSettings } from "../../../shared/settingsTypes";
import { SettingsModalView } from "./settingsModal/SettingsModalView";
import { useSettingsModalController } from "./settingsModal/useSettingsModalController";

type SettingsModalProps = {
  initialSettings: AppSettings;
  busy: boolean;
  jobActive: boolean;
  onCancel: () => void;
  onOpenLogFolder: () => void;
  onReset: () => void;
  onSubmit: (settings: AppSettings) => void;
};

export function SettingsModal(props: SettingsModalProps): React.JSX.Element {
  const controller = useSettingsModalController(props);
  return <SettingsModalView {...controller} />;
}
