import React from "react";
import { IconChevronDown, IconDots } from "@tabler/icons-react";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { ControlTooltip } from "../ui/ControlTooltip";
import { MenuSurface } from "../ui/MenuSurface";
import { usePopupController } from "../ui/usePopupController";
import styles from "./RedactionWorkspace.module.css";

type Item = { label: string; run: () => void; disabled?: boolean };
type Props = {
  label: string;
  items: Item[];
  disabled: boolean;
  iconOnly?: boolean;
};

/** Feature actions share the app's menu, focus and dismissal contracts. */
export function RedactionActionsMenu({
  label,
  items,
  disabled,
  iconOnly,
}: Props): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  const { rootRef, triggerRef, contentRef, toggle, close, openPopup } =
    usePopupController({
      open,
      onOpenChange: setOpen,
      disabled,
      initialFocus: '[role="menuitem"]:not([disabled])',
    });
  const trigger = {
    ref: triggerRef,
    disabled,
    onClick: toggle,
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    "aria-controls": open ? id : undefined,
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "ArrowDown") return;
      event.preventDefault();
      openPopup();
    },
  };
  return (
    <div
      ref={rootRef}
      className={styles.actionMenu}
      data-align={iconOnly ? "end" : "start"}
    >
      {iconOnly ? (
        <ControlTooltip content={label} placement="left">
          <IconButton {...trigger} label={label} title="">
            <IconDots size={18} aria-hidden="true" />
          </IconButton>
        </ControlTooltip>
      ) : (
        <Button
          {...trigger}
          size="sm"
          variant="ghost"
          iconRight={<IconChevronDown size={14} aria-hidden="true" />}
        >
          {label}
        </Button>
      )}
      {open ? (
        <MenuSurface
          ref={contentRef}
          id={id}
          ariaLabel={label}
          className={styles.actionMenuSurface}
          onClose={close}
        >
          {items.map((item) => (
            <Button
              key={item.label}
              role="menuitem"
              variant="ghost"
              disabled={item.disabled}
              onClick={() => {
                close(true);
                item.run();
              }}
            >
              {item.label}
            </Button>
          ))}
        </MenuSurface>
      ) : null}
    </div>
  );
}
