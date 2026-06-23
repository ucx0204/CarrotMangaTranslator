import React from "react";
import {
  comboFromEvent,
  formatCombo,
} from "../../lib/shortcuts/comboFromEvent";
import {
  assignBinding,
  effectiveCombo,
  resetBinding,
  SHORTCUT_ACTIONS,
  SHORTCUT_CATEGORY_LABELS,
  SHORTCUT_CATEGORY_ORDER,
  type KeybindingOverrides,
  type ShortcutActionDef,
  type ShortcutActionId,
} from "../../lib/shortcuts/shortcutActions";

export type ShortcutsSettingsPanelProps = {
  overrides: KeybindingOverrides;
  onChange: (next: KeybindingOverrides) => void;
};

export function ShortcutsSettingsPanel({
  overrides,
  onChange,
}: ShortcutsSettingsPanelProps): React.JSX.Element {
  const [capturingId, setCapturingId] = React.useState<ShortcutActionId | null>(
    null,
  );
  const [note, setNote] = React.useState<string | null>(null);

  useCaptureListener({
    capturingId,
    onChange,
    overrides,
    setCapturingId,
    setNote,
  });

  return (
    <div className="settings-field-stack">
      <p className="muted-line modal-note">
        항목을 클릭한 뒤 원하는 키 조합을 누르면 지정됩니다. Esc로 취소,
        “비우기”로 해제할 수 있습니다.
      </p>
      {note ? <p className="muted-line shortcut-binding-note">{note}</p> : null}
      {SHORTCUT_CATEGORY_ORDER.map((category) => (
        <ShortcutCategorySection
          key={category}
          actions={SHORTCUT_ACTIONS.filter(
            (action) => action.category === category,
          )}
          capturingId={capturingId}
          label={SHORTCUT_CATEGORY_LABELS[category]}
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
  const tokens = formatCombo(combo);
  return (
    <div className="shortcut-binding-row">
      <span className="shortcut-binding-label">{action.label}</span>
      <button
        type="button"
        className={`shortcut-binding-combo ${capturing ? "capturing" : ""}`}
        onClick={onCapture}
        aria-label={`${action.label} 단축키 변경`}
      >
        {capturing ? (
          <span className="shortcut-binding-waiting">키 입력 대기…</span>
        ) : tokens.length > 0 ? (
          <span className="shortcut-keys">
            {tokens.map((token, index) => (
              <kbd key={`${token}-${index}`}>{token}</kbd>
            ))}
          </span>
        ) : (
          <span className="shortcut-binding-empty">미지정</span>
        )}
      </button>
      <button
        type="button"
        className="shortcut-binding-action"
        onClick={onReset}
      >
        기본값
      </button>
      <button
        type="button"
        className="shortcut-binding-action"
        onClick={onClear}
        disabled={combo === ""}
      >
        비우기
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
}: {
  capturingId: ShortcutActionId | null;
  onChange: (next: KeybindingOverrides) => void;
  overrides: KeybindingOverrides;
  setCapturingId: React.Dispatch<React.SetStateAction<ShortcutActionId | null>>;
  setNote: React.Dispatch<React.SetStateAction<string | null>>;
}): void {
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
      const { next, displacedLabel } = assignBinding(
        overrides,
        capturingId,
        combo,
      );
      onChange(next);
      setNote(
        displacedLabel
          ? `‘${displacedLabel}’에 지정돼 있던 단축키를 해제하고 옮겼습니다.`
          : null,
      );
      setCapturingId(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [capturingId, onChange, overrides, setCapturingId, setNote]);
}
