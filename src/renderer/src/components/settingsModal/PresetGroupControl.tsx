import React from "react";
import type { BlockFormatGroupId } from "../../../../shared/blockFormat";

export type PresetGroupAvailability = {
  enabledGroups: ReadonlySet<BlockFormatGroupId>;
  disabledTooltip: string;
};

export function PresetGroupControl({
  availability,
  children,
  className = "",
  groupId,
}: {
  availability?: PresetGroupAvailability;
  children: React.ReactNode;
  className?: string;
  groupId: BlockFormatGroupId;
}): React.JSX.Element {
  const tooltipId = React.useId();
  const disabled = Boolean(
    availability && !availability.enabledGroups.has(groupId),
  );
  if (!disabled) return <>{children}</>;
  return (
    <div
      className={[
        "control-tooltip",
        "control-tooltip-top",
        "format-preset-control-guard",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      aria-describedby={tooltipId}
      aria-disabled="true"
      data-preset-group={groupId}
      tabIndex={0}
    >
      <div className="format-preset-control-content" inert>
        {children}
      </div>
      <span
        className="control-tooltip-bubble format-preset-control-tooltip"
        id={tooltipId}
        role="tooltip"
      >
        {availability?.disabledTooltip}
      </span>
    </div>
  );
}
