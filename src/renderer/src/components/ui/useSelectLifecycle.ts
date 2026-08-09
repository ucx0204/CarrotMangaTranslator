import React from "react";
import type { MenuPosition, SelectOption } from "./selectTypes";
import {
  resolveInitialActiveValue,
  resolveMenuPosition,
} from "./selectUtilities";

export type SelectLifecycleProps = {
  activeOptionId: string | undefined;
  activeValue: string;
  close: (restoreFocus?: boolean) => void;
  disabled: boolean;
  hasMenuHeader: boolean;
  menuRef: React.RefObject<HTMLDivElement | null>;
  open: boolean;
  options: readonly SelectOption[];
  query: string;
  rootRef: React.RefObject<HTMLDivElement | null>;
  setActiveValue: React.Dispatch<React.SetStateAction<string>>;
  setPosition: React.Dispatch<React.SetStateAction<MenuPosition | null>>;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  value: string;
  visibleOptions: SelectOption[];
};

export function useSelectLifecycle(props: SelectLifecycleProps): void {
  useMenuPosition(props);
  useOutsideDismiss(props);
  useDisabledClose(props);
  useValueSync(props);
  useVisibleActiveSync(props);
  useActiveOptionScroll(props);
}

function useMenuPosition({
  hasMenuHeader,
  menuRef,
  open,
  query,
  setPosition,
  triggerRef,
  visibleOptions,
}: SelectLifecycleProps): void {
  React.useLayoutEffect(() => {
    if (!open) return;
    const update = (): void => {
      if (!triggerRef.current || !menuRef.current) return;
      setPosition(resolveMenuPosition(triggerRef.current, menuRef.current));
    };
    update();
    const frame = requestAnimationFrame(update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [
    hasMenuHeader,
    menuRef,
    open,
    query,
    setPosition,
    triggerRef,
    visibleOptions.length,
  ]);
}

function useOutsideDismiss({
  close,
  menuRef,
  open,
  rootRef,
}: SelectLifecycleProps): void {
  React.useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        close(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [close, menuRef, open, rootRef]);
}

function useDisabledClose({
  close,
  disabled,
  open,
  options,
}: SelectLifecycleProps): void {
  React.useEffect(() => {
    if (open && (disabled || options.length === 0)) close(false);
  }, [close, disabled, open, options.length]);
}

function useValueSync({
  open,
  setActiveValue,
  value,
}: SelectLifecycleProps): void {
  React.useEffect(() => {
    if (!open) setActiveValue(value);
  }, [open, setActiveValue, value]);
}

function useVisibleActiveSync({
  activeValue,
  open,
  setActiveValue,
  value,
  visibleOptions,
}: SelectLifecycleProps): void {
  React.useEffect(() => {
    const activeVisible = visibleOptions.some(
      (option) => option.value === activeValue && !option.disabled,
    );
    if (open && !activeVisible) {
      setActiveValue(resolveInitialActiveValue(visibleOptions, value));
    }
  }, [activeValue, open, setActiveValue, value, visibleOptions]);
}

function useActiveOptionScroll({
  activeOptionId,
  open,
}: SelectLifecycleProps): void {
  React.useEffect(() => {
    if (!open || !activeOptionId) return;
    document
      .getElementById(activeOptionId)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeOptionId, open]);
}
