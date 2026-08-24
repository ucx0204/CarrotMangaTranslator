import React from "react";
import { handleMenuKeyboardNavigation } from "./ui/menuKeyboard";
import { usePopupController } from "./ui/usePopupController";

export type StageToolbarGroupId = "paint" | "restore";

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

/**
 * Tool-group flyout state. Outside dismissal, Escape, and trigger focus
 * restoration come from `usePopupController`; menu roving comes from
 * `handleMenuKeyboardNavigation`. What stays local is genuinely specific:
 * which of several groups is open, the hover-out grace period, and the guard
 * that stops a focus-restored trigger from immediately reopening.
 */
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
  const focusMenuOnOpenRef = React.useRef<StageToolbarGroupId | null>(null);
  const suppressNextFocusOpenRef = React.useRef(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelScheduledClose = React.useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const { close, rootRef, triggerRef } = usePopupController({
    disabled: disabled || hidden,
    open: openGroup !== null,
    onOpenChange: (next, options) => {
      if (next) return;
      cancelScheduledClose();
      focusMenuOnOpenRef.current = null;
      // The trigger opens on focus, so a focus-restoring close has to arm the
      // guard before the focus lands.
      if (options?.restoreFocus) suppressNextFocusOpenRef.current = true;
      setOpenGroup(null);
    },
  });

  const scheduleClose = React.useCallback(
    (group: StageToolbarGroupId) => {
      cancelScheduledClose();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const groupNode = rootRef.current?.querySelector<HTMLElement>(
          `[data-stage-tool-group-control="${group}"]`,
        );
        if (groupNode?.contains(document.activeElement)) return;
        setOpenGroup((current) => (current === group ? null : current));
      }, POINTER_LEAVE_CLOSE_DELAY_MS);
    },
    [cancelScheduledClose, rootRef],
  );

  const actions = useFlyoutActions({
    cancelScheduledClose,
    focusMenuOnOpenRef,
    openGroup,
    popupClose: close,
    rootRef,
    setOpenGroup,
    suppressNextFocusOpenRef,
    triggerRef,
  });

  React.useEffect(() => {
    if (disabled || hidden) setOpenGroup(null);
  }, [disabled, hidden]);
  React.useEffect(() => () => cancelScheduledClose(), [cancelScheduledClose]);

  React.useLayoutEffect(() => {
    if (!openGroup || focusMenuOnOpenRef.current !== openGroup) {
      return;
    }
    focusMenuOnOpenRef.current = null;
    getMenuButtons(rootRef.current, openGroup)[0]?.focus();
  }, [openGroup, rootRef]);

  return {
    ...actions,
    ...useFlyoutKeyboard(close, openGroup),
    cancelScheduledClose,
    openGroup,
    rootRef,
    scheduleClose,
  };
}

function useFlyoutKeyboard(
  close: (restoreFocus?: boolean) => void,
  openGroup: StageToolbarGroupId | null,
): Pick<FlyoutController, "onMenuKeyDown" | "onToolbarBlur"> {
  return {
    onMenuKeyDown: React.useCallback(
      (event: React.KeyboardEvent<HTMLDivElement>) => {
        handleMenuKeyboardNavigation(event, {
          onEscape: () => close(true),
          onTab: () => close(false),
        });
      },
      [close],
    ),
    onToolbarBlur: React.useCallback(
      (event: React.FocusEvent<HTMLDivElement>) => {
        if (
          openGroup &&
          !event.currentTarget.contains(event.relatedTarget as Node | null)
        ) {
          close(false);
        }
      },
      [close, openGroup],
    ),
  };
}

function useFlyoutActions({
  cancelScheduledClose,
  focusMenuOnOpenRef,
  openGroup,
  popupClose,
  rootRef,
  setOpenGroup,
  suppressNextFocusOpenRef,
  triggerRef,
}: {
  cancelScheduledClose: () => void;
  focusMenuOnOpenRef: React.RefObject<StageToolbarGroupId | null>;
  openGroup: StageToolbarGroupId | null;
  popupClose: (restoreFocus?: boolean) => void;
  rootRef: React.RefObject<HTMLDivElement | null>;
  setOpenGroup: SetOpenGroup;
  suppressNextFocusOpenRef: React.RefObject<boolean>;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}): Pick<FlyoutController, "activate" | "close" | "openFromPointerOrFocus"> {
  const openFromPointerOrFocus = React.useCallback(
    (group: StageToolbarGroupId, trigger: HTMLButtonElement) => {
      cancelScheduledClose();
      if (suppressNextFocusOpenRef.current) {
        suppressNextFocusOpenRef.current = false;
        return;
      }
      triggerRef.current = trigger;
      focusMenuOnOpenRef.current = null;
      setOpenGroup(group);
    },
    [
      cancelScheduledClose,
      focusMenuOnOpenRef,
      setOpenGroup,
      suppressNextFocusOpenRef,
      triggerRef,
    ],
  );
  const activate = React.useCallback(
    (group: StageToolbarGroupId, trigger: HTMLButtonElement) => {
      cancelScheduledClose();
      triggerRef.current = trigger;
      if (openGroup === group) {
        getMenuButtons(rootRef.current, group)[0]?.focus();
      } else {
        focusMenuOnOpenRef.current = group;
        setOpenGroup(group);
      }
    },
    [
      cancelScheduledClose,
      focusMenuOnOpenRef,
      openGroup,
      rootRef,
      setOpenGroup,
      triggerRef,
    ],
  );
  return { activate, close: popupClose, openFromPointerOrFocus };
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
