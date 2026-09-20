import React from "react";
import { FloatingControlTooltip } from "./FloatingControlTooltip";

type ControlTooltipProps = {
  children: React.ReactNode | ((descriptionId: string) => React.ReactNode);
  floating?: boolean;
  className?: string;
  content: string;
  placement?: "bottom" | "left" | "right" | "top";
};

/** App-rendered tooltip for compact icon controls; never uses native title UI. */
export function ControlTooltip({
  children,
  floating = false,
  className,
  content,
  placement = "right",
}: ControlTooltipProps): React.JSX.Element {
  const tooltipId = React.useId();
  if (floating)
    return (
      <FloatingControlTooltip content={content} className={className}>
        {children}
      </FloatingControlTooltip>
    );
  const control = React.isValidElement<{ "aria-describedby"?: string }>(
    children,
  )
    ? children
    : null;
  const describedBy = [control?.props["aria-describedby"], tooltipId]
    .filter(Boolean)
    .join(" ");
  return (
    <span
      className={["control-tooltip", `control-tooltip-${placement}`, className]
        .filter(Boolean)
        .join(" ")}
    >
      {control
        ? React.cloneElement(control, { "aria-describedby": describedBy })
        : typeof children === "function"
          ? children(tooltipId)
          : children}
      <span className="control-tooltip-bubble" id={tooltipId} role="tooltip">
        {content}
      </span>
    </span>
  );
}
