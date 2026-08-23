import { useLayoutEffect, useMemo, useRef } from "react";
import type {
  KeybindingOverrides,
  ShortcutActionId,
} from "../../../shared/shortcutSettings";
import { isEditableTarget } from "../lib/appHelpers";
import { comboFromEvent } from "../lib/shortcuts/comboFromEvent";
import {
  getShortcutAction,
  resolveBindings,
} from "../lib/shortcuts/shortcutBindingResolution";
import type {
  ShortcutActionDef,
  ShortcutContext,
} from "../lib/shortcuts/shortcutActionTypes";

export type ShortcutHandlers = Partial<Record<ShortcutActionId, () => void>>;
export type ShortcutHoldHandlers = Partial<
  Record<ShortcutActionId, { onPress: () => void; onRelease: () => void }>
>;

type UseShortcutDispatcherOptions = {
  overrides: KeybindingOverrides;
  context: ShortcutContext;
  handlers: ShortcutHandlers;
  holdHandlers?: ShortcutHoldHandlers;
};

type ActiveShortcutHold = {
  actionId: ShortcutActionId;
  alt: boolean;
  code: string;
  ctrl: boolean;
  key: string;
  onRelease: () => void;
  shift: boolean;
};

type MutableValueRef<T> = { current: T };
type ShortcutDispatcherRefs = {
  activeHold: MutableValueRef<ActiveShortcutHold | null>;
  bindings: MutableValueRef<Map<string, ShortcutActionId>>;
  context: MutableValueRef<ShortcutContext>;
  handlers: MutableValueRef<ShortcutHandlers>;
  holdHandlers: MutableValueRef<ShortcutHoldHandlers>;
};

function isActionAllowed(
  action: ShortcutActionDef,
  actionId: ShortcutActionId,
  context: ShortcutContext,
  target: EventTarget | null,
): boolean {
  if (isBlockedByShortcutOverlay(actionId, context)) return false;
  if (!action.allowInEditable && isEditableTarget(target)) {
    return false;
  }
  return !action.enabled || action.enabled(context);
}

function isBlockedByShortcutOverlay(
  actionId: ShortcutActionId,
  context: ShortcutContext,
): boolean {
  if (context.blockingModalOpen) {
    return actionId !== context.activeModalActionId;
  }
  if (context.paletteOpen) return actionId !== "toggle-command-palette";
  if (!context.helpOpen) return false;
  return (
    actionId !== "toggle-command-palette" && actionId !== "toggle-shortcut-help"
  );
}

/**
 * Single global keydown listener that drives every registered, customizable
 * shortcut. It resolves the pressed combo to an action, applies the global
 * guards (blocking modal, palette/help overlays, editable targets) plus the
 * action's contextual `enabled` predicate, then runs the mapped handler.
 *
 * Latest props are mirrored into refs so the listener is attached once and
 * never goes stale. The listener runs at document capture: focused controls
 * may stop bubbling for their own keyboard behavior, while higher-priority
 * window-capture owners (shortcut recording and block arrow-key nudging) still
 * get the first and exclusive chance to consume their keys.
 */
export function useShortcutDispatcher({
  overrides,
  context,
  handlers,
  holdHandlers = {},
}: UseShortcutDispatcherOptions): void {
  const bindings = useMemo(() => resolveBindings(overrides), [overrides]);
  const bindingsRef = useRef(bindings);
  const contextRef = useRef(context);
  const handlersRef = useRef(handlers);
  const holdHandlersRef = useRef(holdHandlers);
  const activeHoldRef = useRef<ActiveShortcutHold | null>(null);

  useLayoutEffect(() => {
    bindingsRef.current = bindings;
    contextRef.current = context;
    handlersRef.current = handlers;
    holdHandlersRef.current = holdHandlers;
  });

  useShortcutEventListeners({
    activeHold: activeHoldRef,
    bindings: bindingsRef,
    context: contextRef,
    handlers: handlersRef,
    holdHandlers: holdHandlersRef,
  });
}

function useShortcutEventListeners(refs: ShortcutDispatcherRefs): void {
  const stableRefs = useMemo(
    () => ({
      activeHold: refs.activeHold,
      bindings: refs.bindings,
      context: refs.context,
      handlers: refs.handlers,
      holdHandlers: refs.holdHandlers,
    }),
    [
      refs.activeHold,
      refs.bindings,
      refs.context,
      refs.handlers,
      refs.holdHandlers,
    ],
  );
  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void =>
      dispatchShortcutKeyDown(event, stableRefs);
    const onKeyUp = (event: KeyboardEvent): void =>
      dispatchShortcutKeyUp(event, stableRefs.activeHold);
    const release = (): void => releaseShortcutHold(stableRefs.activeHold);
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") release();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", release);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", release);
    };
  }, [stableRefs]);
}

function dispatchShortcutKeyDown(
  event: KeyboardEvent,
  refs: ShortcutDispatcherRefs,
): void {
  const resolved = resolveAllowedShortcut(event, refs);
  if (!resolved) return;
  const { actionId, combo } = resolved;
  const handler = refs.handlers.current[actionId];
  const holdHandler = refs.holdHandlers.current[actionId];
  if (!handler && !holdHandler) return;
  event.preventDefault();
  event.stopPropagation();
  if (holdHandler) {
    startShortcutHold(event, actionId, combo, holdHandler, refs.activeHold);
  } else {
    handler?.();
  }
}

function resolveAllowedShortcut(
  event: KeyboardEvent,
  refs: ShortcutDispatcherRefs,
): { actionId: ShortcutActionId; combo: string } | null {
  if (event.isComposing || event.key === "Process") return null;
  const combo = comboFromEvent(event);
  if (!combo) return null;
  const actionId = refs.bindings.current.get(combo);
  if (!actionId) return null;
  const action = getShortcutAction(actionId);
  return action &&
    isActionAllowed(action, actionId, refs.context.current, event.target)
    ? { actionId, combo }
    : null;
}

function startShortcutHold(
  event: KeyboardEvent,
  actionId: ShortcutActionId,
  combo: string,
  handler: { onPress: () => void; onRelease: () => void },
  activeRef: MutableValueRef<ActiveShortcutHold | null>,
): void {
  if (event.repeat || activeRef.current?.actionId === actionId) return;
  releaseShortcutHold(activeRef);
  activeRef.current = createActiveShortcutHold(
    actionId,
    combo,
    event,
    handler.onRelease,
  );
  handler.onPress();
}

function dispatchShortcutKeyUp(
  event: KeyboardEvent,
  activeRef: MutableValueRef<ActiveShortcutHold | null>,
): void {
  const active = activeRef.current;
  if (!active || !doesKeyUpReleaseHold(active, event)) return;
  event.preventDefault();
  event.stopPropagation();
  releaseShortcutHold(activeRef);
}

function releaseShortcutHold(
  activeRef: MutableValueRef<ActiveShortcutHold | null>,
): void {
  const active = activeRef.current;
  if (!active) return;
  activeRef.current = null;
  active.onRelease();
}

function createActiveShortcutHold(
  actionId: ShortcutActionId,
  combo: string,
  event: KeyboardEvent,
  onRelease: () => void,
): ActiveShortcutHold {
  return {
    actionId,
    alt: combo.startsWith("alt+") || combo.includes("+alt+"),
    code: event.code,
    ctrl: combo.startsWith("ctrl+") || combo.includes("+ctrl+"),
    key: event.key,
    onRelease,
    shift: combo.startsWith("shift+") || combo.includes("+shift+"),
  };
}

function doesKeyUpReleaseHold(
  active: ActiveShortcutHold,
  event: KeyboardEvent,
): boolean {
  if (active.code && event.code === active.code) return true;
  if (!active.code && event.key === active.key) return true;
  if (active.ctrl && ["Control", "Meta", "OS"].includes(event.key)) {
    return true;
  }
  if (active.alt && ["Alt", "AltGraph"].includes(event.key)) return true;
  return active.shift && event.key === "Shift";
}
