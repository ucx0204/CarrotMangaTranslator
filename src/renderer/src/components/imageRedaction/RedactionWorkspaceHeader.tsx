import React from "react";
import { useTranslation } from "react-i18next";
import { IconInfoCircle } from "@tabler/icons-react";
import { ControlTooltip } from "../ui/ControlTooltip";
import { IconButton } from "../ui/IconButton";
import { RedactionActionsMenu } from "./RedactionActionsMenu";
import styles from "./RedactionWorkspace.module.css";

type Props = {
  disabled: boolean;
  hasPreviousMask: boolean;
  preparation: boolean;
  onHelp: () => void;
  onPresets: () => void;
  onPreviousMask: () => void;
  onExit: () => void;
};
export function RedactionWorkspaceHeader(props: Props): React.JSX.Element {
  const { t } = useTranslation("components");
  const { disabled, hasPreviousMask, preparation } = props;
  return (
    <div className={styles.headerTools}>
      <ControlTooltip
        content={t(
          preparation
            ? "manualRedaction.preparationHint"
            : "manualRedaction.outboundHint",
        )}
        placement="left"
      >
        <IconButton label={t("manualRedaction.about")} title="">
          <IconInfoCircle size={18} aria-hidden="true" />
        </IconButton>
      </ControlTooltip>
      <RedactionActionsMenu
        iconOnly
        label={t("common.settings")}
        disabled={disabled}
        items={[
          {
            label: t("manualRedaction.previousMask"),
            run: props.onPreviousMask,
            disabled: !hasPreviousMask,
          },
          { label: t("manualRedaction.presets"), run: props.onPresets },
          { label: t("manualRedaction.shortcuts"), run: props.onHelp },
          { label: t("manualRedaction.saveExit"), run: props.onExit },
        ]}
      />
    </div>
  );
}
