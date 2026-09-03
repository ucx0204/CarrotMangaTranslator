import React from "react";
import { useTranslation } from "react-i18next";

export function StageToolbarCurrentTool({
  className,
  label,
}: {
  className?: string;
  label: string;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <span
      className={["stage-toolbar-current-tool", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      aria-live="polite"
    >
      {t("stageToolbar.currentTool", { tool: label })}
    </span>
  );
}
