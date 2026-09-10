import React from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, TextField } from "../ui/Field";
import { CheckboxField } from "../ui/CheckboxField";
import { changeRedactionPreferences } from "./redactionWorkspaceModel";
import { validRedactionNavigationKeys } from "./redactionKeyboard";
import type { RedactionWorkspaceController } from "./useRedactionWorkspace";
import styles from "./RedactionWorkspace.module.css";

export function RedactionShortcutDialog({
  form,
  onClose,
}: {
  form: RedactionWorkspaceController;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const preferences = form.state.workspace.preferences;
  const [previous, setPrevious] = React.useState(preferences.previousKey);
  const [next, setNext] = React.useState(preferences.nextKey);
  const valid = validRedactionNavigationKeys(previous, next);
  const rows = [
    ["Z / X · ← / →", "keysNavigate"],
    ["Enter", "keysConfirm"],
    ["Shift+Enter", "keysDefer"],
    ["Ctrl+Enter / ⌘Enter", "keysContinue"],
    ["R / B / E / V / H", "keysTools"],
    ["Space + Drag", "keysPan"],
    ["[ / ]", "keysSize"],
    ["Ctrl+Z / ⌘Z", "keysUndo"],
    ["Ctrl+Shift+Z / ⌘⇧Z", "keysRedo"],
    ["F / 1", "keysZoom"],
  ];
  return (
    <Modal
      title={t("manualRedaction.shortcuts")}
      size="md"
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          disabled={!valid}
          onClick={() => {
            form.commit((current) =>
              changeRedactionPreferences(current, {
                previousKey: previous,
                nextKey: next,
              }),
            );
            onClose();
          }}
        >
          {t("manualRedaction.saveAndClose")}
        </Button>
      }
    >
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
      <p className={styles.hint}>{t("manualRedaction.shortcutScope")}</p>
      <CheckboxField
        checked={preferences.letterShortcuts}
        onCheckedChange={(letterShortcuts) =>
          form.commit((current) =>
            changeRedactionPreferences(current, { letterShortcuts }),
          )
        }
        label={t("manualRedaction.letterShortcuts")}
      />
      <div className={styles.previewPair}>
        <Field label={t("manualRedaction.previousKey")}>
          <TextField
            maxLength={1}
            value={previous}
            onChange={(event) => setPrevious(event.target.value.toLowerCase())}
          />
        </Field>
        <Field label={t("manualRedaction.nextKey")}>
          <TextField
            maxLength={1}
            value={next}
            onChange={(event) => setNext(event.target.value.toLowerCase())}
          />
        </Field>
      </div>
      {!valid ? (
        <p role="alert" className={styles.inlineError}>
          {t("manualRedaction.keyConflict")}
        </p>
      ) : null}
      <CheckboxField
        checked={preferences.keepZoom}
        onCheckedChange={(keepZoom) =>
          form.commit((current) =>
            changeRedactionPreferences(current, { keepZoom }),
          )
        }
        label={t("manualRedaction.keepZoom")}
      />
    </Modal>
  );
}
