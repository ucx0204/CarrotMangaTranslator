import React from "react";
import { ShortcutBindingsContext } from "../../lib/shortcuts/shortcutBindingsContext";
import { isEditableTarget } from "../../lib/appHelpers";
import {
  redactionKeyAction,
  type RedactionKeyAction,
} from "./redactionKeyboard";
import { restoreRedactionEdit } from "./redactionSession";
import {
  changeRedactionPreferences,
  changeRedactionStrokes,
  changeRedactionView,
} from "./redactionWorkspaceModel";
import type { RedactionWorkspaceController } from "./useRedactionWorkspace";

type Options = {
  form: RedactionWorkspaceController;
  selected: number;
  setSelected: (value: number) => void;
  onPrevious: () => void;
  onNext: () => void;
  onConfirm: () => void;
  onContinue: () => void;
  dialogOpen: boolean;
};
export function useRedactionKeyboard(options: Options) {
  const overrides = React.useContext(ShortcutBindingsContext);
  const [spaceHeld, setSpaceHeld] = React.useState(false);
  React.useEffect(() => {
    const release = () => setSpaceHeld(false);
    window.addEventListener("blur", release);
    return () => window.removeEventListener("blur", release);
  }, []);
  return {
    spaceHeld,
    handlers: {
      onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (
          options.dialogOpen ||
          options.form.busy ||
          options.form.drawing ||
          isInteractive(event.target)
        )
          return;
        const action = redactionKeyAction(
          { ...event, isComposing: event.nativeEvent.isComposing },
          options.form.state.workspace.preferences,
          overrides,
        );
        if (!action) return;
        event.preventDefault();
        event.stopPropagation();
        if (action === "pan-held") setSpaceHeld(true);
        else executeKey(action, options);
      },
      onKeyUp: (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === " ") setSpaceHeld(false);
      },
      onBlur: (event: React.FocusEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setSpaceHeld(false);
      },
    },
  };
}
function isInteractive(target: EventTarget | null): boolean {
  if (isEditableTarget(target)) return true;
  return (
    target instanceof Element &&
    Boolean(
      target.closest("button, a, [role=tab], [role=combobox], [role=listbox]"),
    )
  );
}
function executeKey(
  action: Exclude<RedactionKeyAction, "pan-held">,
  options: Options,
): void {
  const navigation: Partial<Record<RedactionKeyAction, () => void>> = {
    previous: options.onPrevious,
    next: options.onNext,
    confirm: options.onConfirm,
    continue: options.onContinue,
  };
  const navigate = navigation[action];
  if (navigate) {
    navigate();
    return;
  }
  const id = options.form.state.workspace.view.currentId;
  if (action === "undo" || action === "redo") {
    options.form.commit((current) => restoreRedactionEdit(current, action, id));
    options.setSelected(-1);
    return;
  }
  if (action === "delete") {
    if (options.selected < 0) return;
    options.form.commit((current) =>
      changeRedactionStrokes(
        current,
        id,
        current.documents[id].strokes.filter(
          (_, index) => index !== options.selected,
        ),
      ),
    );
    options.setSelected(-1);
    return;
  }
  applyToolKey(action, options.form, id);
}
function applyToolKey(
  action: RedactionKeyAction,
  form: RedactionWorkspaceController,
  id: string,
): void {
  if (
    action === "rectangle" ||
    action === "brush" ||
    action === "erase" ||
    action === "select" ||
    action === "pan"
  ) {
    form.commit((current) =>
      changeRedactionPreferences(current, { tool: action }),
    );
    return;
  }
  if (action === "smaller" || action === "larger") {
    form.commit((current) =>
      changeRedactionPreferences(current, {
        size: Math.max(
          1,
          Math.min(
            1000,
            current.workspace.preferences.size +
              (action === "smaller" ? -4 : 4),
          ),
        ),
      }),
    );
    return;
  }
  if (action === "fit" || action === "actual")
    form.commit((current) =>
      changeRedactionView(current, {
        pageViews: {
          ...current.workspace.view.pageViews,
          [id]: {
            ...(current.workspace.view.pageViews[id] ?? { x: 0, y: 0 }),
            zoom: action === "fit" ? 0 : 100,
          },
        },
      }),
    );
}
