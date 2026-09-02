import { useEffect, useRef, type RefObject } from "react";
import { isInteractiveControlTarget } from "../lib/appHelpers";
import {
  resolveBlockNudgeDirection,
  resolveBlockNudgeDistancePx,
  resolveHeldBlockNudgeDelta,
} from "../lib/blockKeyboardNudge";
import { useEventCallback } from "./useEventCallback";

type UseSelectedBlockKeyboardNudgeOptions = {
  blocked: boolean;
  enabled: boolean;
  onNudge: (deltaPx: { x: number; y: number }) => void;
  workspacePanelRef: RefObject<HTMLElement | null>;
};

const KEYBOARD_NUDGE_TICK_MS = 40;
const KEYBOARD_NUDGE_REPEAT_DELAY_MS = 300;

type KeyboardNudgeRuntime = {
  heldKeys: Set<string>;
  repeatDelayId: number | null;
  sessionStartedAt: number | null;
  shiftHeld: boolean;
  tickerId: number | null;
};

type KeyboardNudgeControllerOptions = {
  blocked: boolean;
  enabled: boolean;
  invokeNudge: (deltaPx: { x: number; y: number }) => void;
  runtime: KeyboardNudgeRuntime;
  workspacePanelRef: RefObject<HTMLElement | null>;
};

type KeyboardNudgeController = {
  clear: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onKeyUp: (event: KeyboardEvent) => void;
};

/**
 * Consumes arrow keys while an editable block is selected in the workspace.
 * A quick tap moves exactly 1 px. After a short hold delay, one app-owned
 * ticker drives every held direction while following a smooth 1 → 8 px curve.
 */
export function useSelectedBlockKeyboardNudge({
  blocked,
  enabled,
  onNudge,
  workspacePanelRef,
}: UseSelectedBlockKeyboardNudgeOptions): void {
  const invokeNudge = useEventCallback(onNudge);
  // Keep the mutable runtime behind one hook so editing its fields during
  // development does not change AppSession's flattened Fast Refresh signature.
  const runtimeRef = useRef<KeyboardNudgeRuntime>({
    heldKeys: new Set(),
    repeatDelayId: null,
    sessionStartedAt: null,
    shiftHeld: false,
    tickerId: null,
  });

  useEffect(() => {
    const controller = createKeyboardNudgeController({
      blocked,
      enabled,
      invokeNudge,
      runtime: runtimeRef.current,
      workspacePanelRef,
    });
    window.addEventListener("keydown", controller.onKeyDown, true);
    window.addEventListener("keyup", controller.onKeyUp, true);
    window.addEventListener("blur", controller.clear);
    return () => {
      controller.clear();
      window.removeEventListener("keydown", controller.onKeyDown, true);
      window.removeEventListener("keyup", controller.onKeyUp, true);
      window.removeEventListener("blur", controller.clear);
    };
  }, [blocked, enabled, invokeNudge, workspacePanelRef]);
}

function createKeyboardNudgeController(
  options: KeyboardNudgeControllerOptions,
): KeyboardNudgeController {
  const { runtime } = options;
  const stopRepeat = (): void => {
    if (runtime.repeatDelayId !== null) {
      window.clearTimeout(runtime.repeatDelayId);
      runtime.repeatDelayId = null;
    }
    if (runtime.tickerId !== null) {
      window.clearInterval(runtime.tickerId);
      runtime.tickerId = null;
    }
  };
  const clear = (): void => {
    stopRepeat();
    runtime.heldKeys.clear();
    runtime.sessionStartedAt = null;
    runtime.shiftHeld = false;
  };
  const emit = (now: number): void => {
    if (!canEmitKeyboardNudge(options)) return;
    const startedAt = runtime.sessionStartedAt;
    if (startedAt === null) return;
    const distancePx = resolveBlockNudgeDistancePx(
      now - startedAt,
      runtime.shiftHeld,
    );
    const delta = resolveHeldBlockNudgeDelta(runtime.heldKeys, distancePx);
    if (delta) options.invokeNudge(delta);
  };
  const startTicker = (): void => {
    if (runtime.repeatDelayId !== null || runtime.tickerId !== null) return;
    runtime.repeatDelayId = window.setTimeout(() => {
      runtime.repeatDelayId = null;
      if (runtime.heldKeys.size === 0) return;
      emit(nowMs());
      runtime.tickerId = window.setInterval(
        () => emit(nowMs()),
        KEYBOARD_NUDGE_TICK_MS,
      );
    }, KEYBOARD_NUDGE_REPEAT_DELAY_MS);
  };
  return {
    clear,
    onKeyDown: createNudgeKeyDownHandler(options, emit, startTicker),
    onKeyUp: createNudgeKeyUpHandler(runtime, stopRepeat),
  };
}

function createNudgeKeyDownHandler(
  options: KeyboardNudgeControllerOptions,
  emit: (now: number) => void,
  startTicker: () => void,
): (event: KeyboardEvent) => void {
  return (event) => {
    const { runtime } = options;
    if (event.key === "Shift") {
      runtime.shiftHeld = true;
      return;
    }
    if (!isNudgeKeyDownAllowed(event, options)) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    const now = nowMs();
    runtime.shiftHeld = event.shiftKey;
    if (!runtime.heldKeys.has(event.key)) {
      if (runtime.heldKeys.size === 0) runtime.sessionStartedAt = now;
      runtime.heldKeys.add(event.key);
      emit(now);
    }
    startTicker();
  };
}

function createNudgeKeyUpHandler(
  runtime: KeyboardNudgeRuntime,
  stopRepeat: () => void,
): (event: KeyboardEvent) => void {
  return (event) => {
    if (event.key === "Shift") {
      runtime.shiftHeld = false;
      return;
    }
    if (!resolveBlockNudgeDirection(event.key)) return;
    runtime.heldKeys.delete(event.key);
    if (runtime.heldKeys.size > 0) return;
    stopRepeat();
    runtime.sessionStartedAt = null;
  };
}

function isNudgeKeyDownAllowed(
  event: KeyboardEvent,
  { blocked, enabled, workspacePanelRef }: KeyboardNudgeControllerOptions,
): boolean {
  return Boolean(
    resolveBlockNudgeDirection(event.key) &&
    enabled &&
    !blocked &&
    !event.isComposing &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !isInteractiveControlTarget(event.target) &&
    workspaceHasFocus(workspacePanelRef.current),
  );
}

function canEmitKeyboardNudge({
  blocked,
  enabled,
  workspacePanelRef,
}: KeyboardNudgeControllerOptions): boolean {
  const activeElement =
    typeof document === "undefined" ? null : document.activeElement;
  return (
    enabled &&
    !blocked &&
    workspaceHasFocus(workspacePanelRef.current) &&
    !isInteractiveControlTarget(activeElement)
  );
}

function workspaceHasFocus(panel: HTMLElement | null): boolean {
  const activeElement =
    typeof document === "undefined" ? null : document.activeElement;
  return Boolean(panel && activeElement && panel.contains(activeElement));
}

function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}
