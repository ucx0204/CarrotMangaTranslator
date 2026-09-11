import React from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { ControlTooltip } from "../ui/ControlTooltip";
import { formatCombo } from "../../lib/shortcuts/comboFromEvent";
import { CheckboxField } from "../ui/CheckboxField";
import { changeRedactionPreferences } from "./redactionWorkspaceModel";
import { useRedactionShortcutLabels } from "./useRedactionShortcutLabels";
import type { RedactionWorkspaceController } from "./useRedactionWorkspace";
import styles from "./RedactionWorkspace.module.css";

type Props = { form: RedactionWorkspaceController; onClose: () => void };
type ShortcutModel = ReturnType<typeof useShortcutModel>;

export function RedactionShortcutDialog(props: Props): React.JSX.Element {
  const { t } = useTranslation("components");
  const model = useShortcutModel(props);
  return (
    <Modal
      title={t("manualRedaction.shortcuts")}
      size="md"
      onClose={props.onClose}
      footer={
        <ControlTooltip
          content={t("manualRedaction.shortcutScope")}
          placement="top"
        >
          <Button variant="primary" onClick={model.save}>
            {t("manualRedaction.saveAndClose")}
          </Button>
        </ControlTooltip>
      }
    >
      <ShortcutList model={model} />
      <ShortcutFields model={model} form={props.form} />
    </Modal>
  );
}

function useShortcutModel({ form, onClose }: Props) {
  const preferences = form.state.workspace.preferences;
  return { preferences, save: onClose };
}

function ShortcutList({ model }: { model: ShortcutModel }): React.JSX.Element {
  const { t } = useTranslation("components");
  const keys = useRedactionShortcutLabels(model.preferences);
  const rows = [
    [keys("previous", "next"), "keysNavigate"],
    [formatCombo("enter"), "keysConfirm"],
    [formatCombo("ctrl+enter"), "keysContinue"],
    [keys("rectangle", "brush", "erase", "select", "pan"), "keysTools"],
    [formatCombo(" "), "keysPan"],
    [keys("smaller", "larger"), "keysSize"],
    [keys("undo"), "keysUndo"],
    [keys("redo"), "keysRedo"],
    [keys("fit", "actual"), "keysZoom"],
  ];
  return (
    <dl className={styles.shortcutGrid}>
      {rows.map(([keys, label]) => (
        <React.Fragment key={label}>
          <dt>
            <kbd>{keys}</kbd>
          </dt>
          <dd>{t(`manualRedaction.${label}`)}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function ShortcutFields({
  model,
  form,
}: {
  model: ShortcutModel;
  form: RedactionWorkspaceController;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <CheckboxField
        checked={model.preferences.letterShortcuts}
        onCheckedChange={(letterShortcuts) =>
          form.commit((current) =>
            changeRedactionPreferences(current, { letterShortcuts }),
          )
        }
        label={t("manualRedaction.letterShortcuts")}
      />
      <CheckboxField
        checked={model.preferences.keepZoom}
        onCheckedChange={(keepZoom) =>
          form.commit((current) =>
            changeRedactionPreferences(current, { keepZoom }),
          )
        }
        label={t("manualRedaction.keepZoom")}
      />
    </>
  );
}
