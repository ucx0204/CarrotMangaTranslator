import { useTranslation } from "react-i18next";
import type { WorkspaceTool } from "../lib/stageTool";
import { STAGE_TOOL_BY_ID } from "./stageToolbarTools";

export function useStageToolbarCurrentToolLabel(
  tool: WorkspaceTool,
  regionTranslationActive: boolean,
): string {
  const { t } = useTranslation("components");
  return regionTranslationActive
    ? t("stageToolbar.tools.region.label")
    : t(
        STAGE_TOOL_BY_ID.get(tool)?.labelKey ??
          "stageToolbar.tools.select.label",
      );
}
