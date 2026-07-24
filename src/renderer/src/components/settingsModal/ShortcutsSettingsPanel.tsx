import React from "react";
import { useTranslation } from "react-i18next";
import type {
  KeybindingOverrides,
  ShortcutActionId,
} from "../../../../shared/shortcutSettings";
import {
  comboFromEvent,
  formatCombo,
} from "../../lib/shortcuts/comboFromEvent";
import {
  assignBinding,
  effectiveCombo,
  resetBinding,
  SHORTCUT_ACTIONS,
  SHORTCUT_CATEGORY_ORDER,
  type ShortcutActionDef,
} from "../../lib/shortcuts/shortcutActions";

export type ShortcutsSettingsPanelProps = {
  overrides: KeybindingOverrides;
  onChange: (next: KeybindingOverrides) => void;
};

export function ShortcutsSettingsPanel({
  overrides,
  onChange,
}: ShortcutsSettingsPanelProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const [capturingId, setCapturingId] = React.useState<ShortcutActionId | null>(
    null,
  );
  const [note, setNote] = React.useState<string | null>(null);
  const translateActionLabel = React.useCallback(
    (actionId: ShortcutActionId) => t(`settings.shortcuts.actions.${actionId}`),
    [t],
  );

  useCaptureListener({
    capturingId,
    onChange,
    overrides,
    setCapturingId,
    setNote,
    translateActionLabel,
  });

  return (
    <div className="settings-field-stack">
      <p className="muted-line modal-note">
        {t("settings.shortcuts.description")}
      </p>
      {note ? <p className="muted-line shortcut-binding-note">{note}</p> : null}
      {SHORTCUT_CATEGORY_ORDER.map((category) => (
        <ShortcutCategorySection
          key={category}
          actions={SHORTCUT_ACTIONS.filter(
            (action) => action.category === category,
          ).map((action) => ({
            ...action,
            label: translateActionLabel(action.id),
          }))}
          capturingId={capturingId}
          label={t(`settings.shortcuts.categories.${category}`)}
          onChange={onChange}
          overrides={overrides}
          setCapturingId={setCapturingId}
          setNote={setNote}
        />
      ))}
    </div>
  );
}

type SectionProps = {
  actions: ShortcutActionDef[];
  capturingId: ShortcutActionId | null;
  label: string;
  onChange: (next: KeybindingOverrides) => void;
  overrides: KeybindingOverrides;
  setCapturingId: React.Dispatch<React.SetStateAction<ShortcutActionId | null>>;
  setNote: React.Dispatch<React.SetStateAction<string | null>>;
};

function ShortcutCategorySection({
  actions,
  capturingId,
  label,
  onChange,
  overrides,
  setCapturingId,
  setNote,
}: SectionProps): React.JSX.Element {
  return (
    <section className="shortcut-binding-group">
      <h3 className="shortcut-binding-group-title">{label}</h3>
      <div className="shortcut-binding-list">
        {actions.map((action) => (
          <ShortcutBindingRow
            key={action.id}
            action={action}
            capturing={capturingId === action.id}
            combo={effectiveCombo(action.id, overrides)}
            onCapture={() => {
              setNote(null);
              setCapturingId((current) =>
                current === action.id ? null : action.id,
              );
            }}
            onClear={() => {
              setNote(null);
              setCapturingId(null);
              onChange({ ...overrides, [action.id]: "" });
            }}
            onReset={() => {
              setNote(null);
              setCapturingId(null);
              onChange(resetBinding(overrides, action.id));
            }}
          />
        ))}
      </div>
    </section>
  );
}

type RowProps = {
  action: ShortcutActionDef;
  capturing: boolean;
  combo: string;
  onCapture: () => void;
  onClear: () => void;
  onReset: () => void;
};

function ShortcutBindingRow({
  action,
  capturing,
  combo,
  onCapture,
  onClear,
  onReset,
}: RowProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const tokens = formatCombo(combo);
  return (
    <div className="shortcut-binding-row">
      <span className="shortcut-binding-label">{action.label}</span>
      <button
        type="button"
        className={`shortcut-binding-combo ${capturing ? "capturing" : ""}`}
        onClick={onCapture}
        aria-label={t("settings.shortcuts.changeAria", {
          label: action.label,
        })}
      >
        {capturing ? (
          <span className="shortcut-binding-waiting">
            {t("settings.shortcuts.waiting")}
          </span>
        ) : tokens.length > 0 ? (
          <span className="shortcut-keys">
            {tokens.map((token, index) => (
              <kbd key={`${token}-${index}`}>{token}</kbd>
            ))}
          </span>
        ) : (
          <span className="shortcut-binding-empty">
            {t("settings.shortcuts.unassigned")}
          </span>
        )}
      </button>
      <button
        type="button"
        className="shortcut-binding-action"
        onClick={onReset}
      >
        {t("settings.shortcuts.reset")}
      </button>
      <button
        type="button"
        className="shortcut-binding-action"
        onClick={onClear}
        disabled={combo === ""}
      >
        {t("settings.shortcuts.clear")}
      </button>
    </div>
  );
}

function useCaptureListener({
  capturingId,
  onChange,
  overrides,
  setCapturingId,
  setNote,
  translateActionLabel,
}: {
  capturingId: ShortcutActionId | null;
  onChange: (next: KeybindingOverrides) => void;
  overrides: KeybindingOverrides;
  setCapturingId: React.Dispatch<React.SetStateAction<ShortcutActionId | null>>;
  setNote: React.Dispatch<React.SetStateAction<string | null>>;
  translateActionLabel: (actionId: ShortcutActionId) => string;
}): void {
  const { t } = useTranslation("components");
  const { t: tRenderer } = useTranslation("renderer");
  React.useEffect(() => {
    if (!capturingId) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturingId(null);
        return;
      }
      const combo = comboFromEvent(event);
      if (!combo) {
        return;
      }
      const { next, displacedActionId } = assignBinding(
        overrides,
        capturingId,
        combo,
        tRenderer,
      );
      onChange(next);
      setNote(
        displacedActionId
          ? t("settings.shortcuts.displaced", {
              label: translateActionLabel(displacedActionId),
            })
          : null,
      );
      setCapturingId(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [
    capturingId,
    onChange,
    overrides,
    setCapturingId,
    setNote,
    t,
    tRenderer,
    translateActionLabel,
  ]);
}
