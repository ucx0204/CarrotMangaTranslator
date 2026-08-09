import React from "react";
import { handleMenuKeyboardNavigation } from "./menuKeyboard";

export type MenuSurfaceProps = Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "aria-label" | "onKeyDown" | "role"
> & {
  ariaLabel: string;
  onClose: (restoreFocus?: boolean) => void;
};

/** Accessible DOM-focused menu surface with one shared navigation contract. */
export const MenuSurface = React.forwardRef<HTMLDivElement, MenuSurfaceProps>(
  function MenuSurface(
    { ariaLabel, children, onClose, ...rest },
    ref,
  ): React.JSX.Element {
    return (
      <div
        {...rest}
        ref={ref}
        role="menu"
        aria-label={ariaLabel}
        onKeyDown={(event) =>
          handleMenuKeyboardNavigation(event, {
            onEscape: () => onClose(true),
            onTab: () => onClose(false),
          })
        }
      >
        {children}
      </div>
    );
  },
);
