import React from "react";
import { IconButton, type IconButtonProps } from "../ui/IconButton";
import { ControlTooltip } from "../ui/ControlTooltip";

type Props = Omit<IconButtonProps, "title"> & {
  hint?: string;
  placement?: "top" | "bottom" | "left" | "right";
};
export function RedactionIconButton({
  hint,
  placement = "bottom",
  ...props
}: Props): React.JSX.Element {
  return (
    <ControlTooltip content={hint ?? props.label} placement={placement}>
      <IconButton {...props} title="" />
    </ControlTooltip>
  );
}
