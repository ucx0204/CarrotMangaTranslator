import React from "react";
import { useTranslation } from "react-i18next";
import {
  isRetouchTool,
  isSizableRetouchTool,
  type WorkspaceTool,
} from "../lib/stageTool";

export function StageActiveToolBadge({
  brushRadius,
  tool,
}: {
  brushRadius: number;
  tool: WorkspaceTool;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (!isRetouchTool(tool)) return null;
  return (
    <div className="stage-active-tool-badge" role="status">
      <span>{t(`stageToolbar.tools.${tool}.label`)}</span>
      {isSizableRetouchTool(tool) ? (
        <>
          <span aria-hidden="true">·</span>
          <strong>{t("stageToolbar.radius", { radius: brushRadius })}</strong>
        </>
      ) : null}
    </div>
  );
}
