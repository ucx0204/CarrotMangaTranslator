import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type {
  KeybindingOverrides,
  ShortcutActionId,
} from "../../../../shared/shortcutSettings";
import {
  comboFromEvent,
  comboFromWheelEvent,
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
  const { t: tRenderer } = useTranslation("renderer");
  const [capturingId, setCapturingId] = React.useState<ShortcutActionId | null>(
    null,
  );
  const [note, setNote] = React.useState<string | null>(null);
  const translateActionLabel = React.useCallback(
    (actionId: ShortcutActionId) => tRenderer(`shortcuts.actions.${actionId}`),
    [tRenderer],
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
          label={tRenderer(`shortcuts.categories.${category}`)}
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
    const actionId = capturingId;
    const commitCombo = (combo: string): void =>
      commitCapturedCombo(combo, {
        actionId,
        displacedNote: (displacedActionId) =>
          t("settings.shortcuts.displaced", {
            label: translateActionLabel(displacedActionId),
          }),
        onChange,
        overrides,
        setCapturingId,
        setNote,
        tRenderer,
      });
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
      commitCombo(combo);
    };
    const onWheel = (event: WheelEvent): void => {
      if (!isWheelBindableAction(actionId)) {
        return;
      }
      const combo = comboFromWheelEvent(event);
      if (!combo) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      commitCombo(combo);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("wheel", onWheel, {
      capture: true,
      passive: false,
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("wheel", onWheel, true);
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

function isWheelBindableAction(actionId: ShortcutActionId): boolean {
  return actionId === "zoom-in" || actionId === "zoom-out";
}

function commitCapturedCombo(
  combo: string,
  {
    actionId,
    displacedNote,
    onChange,
    overrides,
    setCapturingId,
    setNote,
    tRenderer,
  }: {
    actionId: ShortcutActionId;
    displacedNote: (actionId: ShortcutActionId) => string;
    onChange: (next: KeybindingOverrides) => void;
    overrides: KeybindingOverrides;
    setCapturingId: React.Dispatch<
      React.SetStateAction<ShortcutActionId | null>
    >;
    setNote: React.Dispatch<React.SetStateAction<string | null>>;
    tRenderer: TFunction<"renderer">;
  },
): void {
  const { next, displacedActionId } = assignBinding(
    overrides,
    actionId,
    combo,
    tRenderer,
  );
  onChange(next);
  setNote(displacedActionId ? displacedNote(displacedActionId) : null);
  setCapturingId(null);
}
