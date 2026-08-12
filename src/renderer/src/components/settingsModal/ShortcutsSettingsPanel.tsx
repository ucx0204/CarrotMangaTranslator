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
  effectiveCombosForAction,
  resetBinding,
} from "../../lib/shortcuts/shortcutBindingResolution";
import { SHORTCUT_ACTIONS } from "../../lib/shortcuts/shortcutActions";
import {
  SHORTCUT_CATEGORY_ORDER,
  type ShortcutActionDef,
} from "../../lib/shortcuts/shortcutActionTypes";

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
  const [conflict, setConflict] = React.useState<string | null>(null);
  const translateActionLabel = React.useCallback(
    (actionId: ShortcutActionId) => tRenderer(`shortcuts.actions.${actionId}`),
    [tRenderer],
  );

  useCaptureListener({
    capturingId,
    onChange,
    overrides,
    setCapturingId,
    setConflict,
    translateActionLabel,
  });

  return (
    <div className="settings-field-stack">
      <p className="muted-line modal-note">
        {t("settings.shortcuts.description")}
      </p>
      {conflict ? (
        <p className="shortcut-binding-conflict" role="alert">
          {conflict}
        </p>
      ) : null}
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
          setConflict={setConflict}
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
  setConflict: React.Dispatch<React.SetStateAction<string | null>>;
};

function ShortcutCategorySection({
  actions,
  capturingId,
  label,
  onChange,
  overrides,
  setCapturingId,
  setConflict,
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
            combos={effectiveCombosForAction(action.id, overrides)}
            onCapture={() => {
              setConflict(null);
              setCapturingId((current) =>
                current === action.id ? null : action.id,
              );
            }}
            onClear={() => {
              setConflict(null);
              setCapturingId(null);
              onChange({ ...overrides, [action.id]: "" });
            }}
            onReset={() => {
              setConflict(null);
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
  combos: string[];
  onCapture: () => void;
  onClear: () => void;
  onReset: () => void;
};

function ShortcutBindingRow({
  action,
  capturing,
  combos,
  onCapture,
  onClear,
  onReset,
}: RowProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const tokenGroups = deduplicateDisplayedCombos(combos);
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
        ) : tokenGroups.length > 0 ? (
          <span className="shortcut-binding-combos">
            {tokenGroups.map((tokens, groupIndex) => (
              <React.Fragment key={tokens.join("+")}>
                {groupIndex > 0 ? (
                  <span className="shortcut-binding-alias">/</span>
                ) : null}
                <span className="shortcut-keys">
                  {tokens.map((token, tokenIndex) => (
                    <kbd key={`${token}-${tokenIndex}`}>{token}</kbd>
                  ))}
                </span>
              </React.Fragment>
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
        disabled={combos.length === 0}
      >
        {t("settings.shortcuts.clear")}
      </button>
    </div>
  );
}

function deduplicateDisplayedCombos(combos: string[]): string[][] {
  const unique = new Map<string, string[]>();
  for (const combo of combos) {
    const tokens = formatCombo(combo);
    const displayKey = tokens.join("\u0000");
    if (!unique.has(displayKey)) unique.set(displayKey, tokens);
  }
  return [...unique.values()];
}

function useCaptureListener({
  capturingId,
  onChange,
  overrides,
  setCapturingId,
  setConflict,
  translateActionLabel,
}: {
  capturingId: ShortcutActionId | null;
  onChange: (next: KeybindingOverrides) => void;
  overrides: KeybindingOverrides;
  setCapturingId: React.Dispatch<React.SetStateAction<ShortcutActionId | null>>;
  setConflict: React.Dispatch<React.SetStateAction<string | null>>;
  translateActionLabel: (actionId: ShortcutActionId) => string;
}): void {
  const { t } = useTranslation("components");
  const { t: tRenderer } = useTranslation("renderer");
  React.useEffect(() => {
    if (!capturingId) return;
    return registerCaptureListeners({
      actionId: capturingId,
      conflictNote: (conflictingActionId, combo) =>
        t("settings.shortcuts.conflict", {
          combo: formatCombo(combo).join("+"),
          label: translateActionLabel(conflictingActionId),
        }),
      onChange,
      overrides,
      setCapturingId,
      setConflict,
      tRenderer,
    });
  }, [
    capturingId,
    onChange,
    overrides,
    setCapturingId,
    setConflict,
    t,
    tRenderer,
    translateActionLabel,
  ]);
}

function registerCaptureListeners(
  options: Parameters<typeof commitCapturedCombo>[1],
): () => void {
  const commitCombo = (combo: string): void =>
    commitCapturedCombo(combo, options);
  const onKeyDown = (event: KeyboardEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      options.setCapturingId(null);
      return;
    }
    const combo = comboFromEvent(event);
    if (combo) commitCombo(combo);
  };
  const onWheel = (event: WheelEvent): void => {
    if (!isWheelBindableAction(options.actionId)) return;
    const combo = comboFromWheelEvent(event);
    if (!combo) return;
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
}

function isWheelBindableAction(actionId: ShortcutActionId): boolean {
  return actionId === "zoom-in" || actionId === "zoom-out";
}

function commitCapturedCombo(
  combo: string,
  {
    actionId,
    conflictNote,
    onChange,
    overrides,
    setCapturingId,
    setConflict,
    tRenderer,
  }: {
    actionId: ShortcutActionId;
    conflictNote: (actionId: ShortcutActionId, combo: string) => string;
    onChange: (next: KeybindingOverrides) => void;
    overrides: KeybindingOverrides;
    setCapturingId: React.Dispatch<
      React.SetStateAction<ShortcutActionId | null>
    >;
    setConflict: React.Dispatch<React.SetStateAction<string | null>>;
    tRenderer: TFunction<"renderer">;
  },
): void {
  const { next, conflictingActionId } = assignBinding(
    overrides,
    actionId,
    combo,
    tRenderer,
  );
  if (conflictingActionId) {
    setConflict(conflictNote(conflictingActionId, combo));
    setCapturingId(null);
    return;
  }
  onChange(next);
  setConflict(null);
  setCapturingId(null);
}
