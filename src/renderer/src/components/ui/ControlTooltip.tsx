import React from "react";

type ControlTooltipProps = {
  children: React.ReactNode;
  className?: string;
  content: string;
  placement?: "left" | "right" | "top";
};

/** App-rendered tooltip for compact icon controls; never uses native title UI. */
export function ControlTooltip({
  children,
  className,
  content,
  placement = "right",
}: ControlTooltipProps): React.JSX.Element {
  const tooltipId = React.useId();
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
        : children}
      <span className="control-tooltip-bubble" id={tooltipId} role="tooltip">
        {content}
      </span>
    </span>
  );
}
