import { useEffect, useMemo, useRef } from "react";
import type {
  KeybindingOverrides,
  ShortcutActionId,
} from "../../../shared/shortcutSettings";
import { isEditableTarget } from "../lib/appHelpers";
import { comboFromEvent } from "../lib/shortcuts/comboFromEvent";
import {
  getShortcutAction,
  resolveBindings,
  type ShortcutActionDef,
  type ShortcutContext,
} from "../lib/shortcuts/shortcutActions";

export type ShortcutHandlers = Partial<Record<ShortcutActionId, () => void>>;

type UseShortcutDispatcherOptions = {
  overrides: KeybindingOverrides;
  context: ShortcutContext;
  handlers: ShortcutHandlers;
};

function isActionAllowed(
  action: ShortcutActionDef,
  actionId: ShortcutActionId,
  context: ShortcutContext,
  target: EventTarget | null,
): boolean {
  if (context.blockingModalOpen) {
    return false;
  }
  if (context.paletteOpen && actionId !== "toggle-command-palette") {
    return false;
  }
  if (
    context.helpOpen &&
    actionId !== "toggle-command-palette" &&
    actionId !== "toggle-shortcut-help"
  ) {
    return false;
  }
  if (!action.allowInEditable && isEditableTarget(target)) {
    return false;
  }
  return !action.enabled || action.enabled(context);
}

/**
 * Single global keydown listener that drives every registered, customizable
 * shortcut. It resolves the pressed combo to an action, applies the global
 * guards (blocking modal, palette/help overlays, editable targets) plus the
 * action's contextual `enabled` predicate, then runs the mapped handler.
 *
 * Latest props are mirrored into refs (inside an effect) so the listener is
 * attached once and never goes stale.
 */
export function useShortcutDispatcher({
  overrides,
  context,
  handlers,
}: UseShortcutDispatcherOptions): void {
  const bindings = useMemo(() => resolveBindings(overrides), [overrides]);
  const bindingsRef = useRef(bindings);
  const contextRef = useRef(context);
  const handlersRef = useRef(handlers);

  useEffect(() => {
    bindingsRef.current = bindings;
    contextRef.current = context;
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const combo = comboFromEvent(event);
      if (!combo) {
        return;
      }
      const actionId = bindingsRef.current.get(combo);
      if (!actionId) {
        return;
      }
      const action = getShortcutAction(actionId);
      if (
        !action ||
        !isActionAllowed(action, actionId, contextRef.current, event.target)
      ) {
        return;
      }
      const handler = handlersRef.current[actionId];
      if (!handler) {
        return;
      }
      event.preventDefault();
      handler();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}
