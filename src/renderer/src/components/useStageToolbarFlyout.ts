import React from "react";

export type StageToolbarGroupId = "retouch";

const POINTER_LEAVE_CLOSE_DELAY_MS = 160;

type FlyoutController = {
  activate: (group: StageToolbarGroupId, trigger: HTMLButtonElement) => void;
  cancelScheduledClose: () => void;
  close: (restoreFocus?: boolean) => void;
  onMenuKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onToolbarBlur: (event: React.FocusEvent<HTMLDivElement>) => void;
  openFromPointerOrFocus: (
    group: StageToolbarGroupId,
    trigger: HTMLButtonElement,
  ) => void;
  openGroup: StageToolbarGroupId | null;
  rootRef: React.RefObject<HTMLDivElement | null>;
  scheduleClose: (group: StageToolbarGroupId) => void;
};

type SetOpenGroup = React.Dispatch<
  React.SetStateAction<StageToolbarGroupId | null>
>;

export function useStageToolbarFlyout({
  disabled,
  hidden,
}: {
  disabled: boolean;
  hidden: boolean;
}): FlyoutController {
  const [openGroup, setOpenGroup] = React.useState<StageToolbarGroupId | null>(
    null,
  );
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const focusMenuOnOpenRef = React.useRef<StageToolbarGroupId | null>(null);
  const suppressNextFocusOpenRef = React.useRef(false);
  const delayedClose = useDelayedClose(rootRef, setOpenGroup);
  const actions = useFlyoutActions({
    delayedClose,
    focusMenuOnOpenRef,
    openGroup,
    rootRef,
    setOpenGroup,
    suppressNextFocusOpenRef,
    triggerRef,
  });

  useFlyoutLifecycle({
    cancelScheduledClose: delayedClose.cancel,
    close: actions.close,
    disabled,
    hidden,
    openGroup,
    rootRef,
    setOpenGroup,
  });

  React.useLayoutEffect(() => {
    if (!openGroup || focusMenuOnOpenRef.current !== openGroup) {
      return;
    }
    focusMenuOnOpenRef.current = null;
    getMenuButtons(rootRef.current, openGroup)[0]?.focus();
  }, [openGroup]);

  const keyboard = useFlyoutKeyboard(openGroup, rootRef, actions.close);
  return {
    ...actions,
    cancelScheduledClose: delayedClose.cancel,
    ...keyboard,
    openGroup,
    rootRef,
    scheduleClose: delayedClose.schedule,
  };
}

function useDelayedClose(
  rootRef: React.RefObject<HTMLDivElement | null>,
  setOpenGroup: SetOpenGroup,
): {
  cancel: () => void;
  schedule: (group: StageToolbarGroupId) => void;
} {
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = React.useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);
  const schedule = React.useCallback(
    (group: StageToolbarGroupId) => {
      cancel();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const groupNode = rootRef.current?.querySelector<HTMLElement>(
          `[data-stage-tool-group-control="${group}"]`,
        );
        if (groupNode?.contains(document.activeElement)) return;
        setOpenGroup((current) => (current === group ? null : current));
      }, POINTER_LEAVE_CLOSE_DELAY_MS);
    },
    [cancel, rootRef, setOpenGroup],
  );
  return { cancel, schedule };
}

function useFlyoutActions({
  delayedClose,
  focusMenuOnOpenRef,
  openGroup,
  rootRef,
  setOpenGroup,
  suppressNextFocusOpenRef,
  triggerRef,
}: {
  delayedClose: ReturnType<typeof useDelayedClose>;
  focusMenuOnOpenRef: React.RefObject<StageToolbarGroupId | null>;
  openGroup: StageToolbarGroupId | null;
  rootRef: React.RefObject<HTMLDivElement | null>;
  setOpenGroup: SetOpenGroup;
  suppressNextFocusOpenRef: React.RefObject<boolean>;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}): Pick<FlyoutController, "activate" | "close" | "openFromPointerOrFocus"> {
  const close = React.useCallback(
    (restoreFocus = false) => {
      delayedClose.cancel();
      focusMenuOnOpenRef.current = null;
      setOpenGroup(null);
      if (restoreFocus && document.activeElement !== triggerRef.current) {
        suppressNextFocusOpenRef.current = true;
        triggerRef.current?.focus();
      }
    },
    [
      delayedClose,
      focusMenuOnOpenRef,
      setOpenGroup,
      suppressNextFocusOpenRef,
      triggerRef,
    ],
  );
  const openFromPointerOrFocus = React.useCallback(
    (group: StageToolbarGroupId, trigger: HTMLButtonElement) => {
      delayedClose.cancel();
      if (suppressNextFocusOpenRef.current) {
        suppressNextFocusOpenRef.current = false;
        return;
      }
      triggerRef.current = trigger;
      focusMenuOnOpenRef.current = null;
      setOpenGroup(group);
    },
    [
      delayedClose,
      focusMenuOnOpenRef,
      setOpenGroup,
      suppressNextFocusOpenRef,
      triggerRef,
    ],
  );
  const activate = React.useCallback(
    (group: StageToolbarGroupId, trigger: HTMLButtonElement) => {
      delayedClose.cancel();
      triggerRef.current = trigger;
      if (openGroup === group) {
        getMenuButtons(rootRef.current, group)[0]?.focus();
      } else {
        focusMenuOnOpenRef.current = group;
        setOpenGroup(group);
      }
    },
    [
      delayedClose,
      focusMenuOnOpenRef,
      openGroup,
      rootRef,
      setOpenGroup,
      triggerRef,
    ],
  );
  return { activate, close, openFromPointerOrFocus };
}

function useFlyoutKeyboard(
  openGroup: StageToolbarGroupId | null,
  rootRef: React.RefObject<HTMLDivElement | null>,
  close: FlyoutController["close"],
): Pick<FlyoutController, "onMenuKeyDown" | "onToolbarBlur"> {
  const onMenuKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!openGroup) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
        return;
      }
      const next = resolveNextMenuButton(
        getMenuButtons(rootRef.current, openGroup),
        event,
      );
      if (next) {
        event.preventDefault();
        next.focus();
      }
    },
    [close, openGroup, rootRef],
  );
  const onToolbarBlur = React.useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      if (
        openGroup &&
        !event.currentTarget.contains(event.relatedTarget as Node | null)
      ) {
        close();
      }
    },
    [close, openGroup],
  );
  return { onMenuKeyDown, onToolbarBlur };
}

function useFlyoutLifecycle({
  cancelScheduledClose,
  close,
  disabled,
  hidden,
  openGroup,
  rootRef,
  setOpenGroup,
}: {
  cancelScheduledClose: () => void;
  close: () => void;
  disabled: boolean;
  hidden: boolean;
  openGroup: StageToolbarGroupId | null;
  rootRef: React.RefObject<HTMLDivElement | null>;
  setOpenGroup: React.Dispatch<
    React.SetStateAction<StageToolbarGroupId | null>
  >;
}): void {
  React.useEffect(() => {
    if (disabled || hidden) setOpenGroup(null);
  }, [disabled, hidden, setOpenGroup]);
  React.useEffect(() => {
    if (!openGroup) return;
    const closeOutside = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", closeOutside, true);
    return () =>
      document.removeEventListener("pointerdown", closeOutside, true);
  }, [close, openGroup, rootRef]);
  React.useEffect(
    () => () => {
      cancelScheduledClose();
    },
    [cancelScheduledClose],
  );
}

function getMenuButtons(
  root: HTMLElement | null,
  group: StageToolbarGroupId,
): HTMLButtonElement[] {
  return Array.from(
    root?.querySelectorAll<HTMLButtonElement>(
      `[data-stage-tool-menu="${group}"] button:not(:disabled)`,
    ) ?? [],
  );
}

function resolveNextMenuButton(
  buttons: HTMLButtonElement[],
  event: React.KeyboardEvent<HTMLDivElement>,
): HTMLButtonElement | null {
  if (!buttons.length) return null;
  if (event.key === "Home") return buttons[0] ?? null;
  if (event.key === "End") return buttons.at(-1) ?? null;
  if (
    !["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)
  ) {
    return null;
  }
  const current = buttons.indexOf(event.target as HTMLButtonElement);
  const delta =
    event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
  const index =
    (Math.max(0, current) + delta + buttons.length) % buttons.length;
  return buttons[index] ?? null;
}
