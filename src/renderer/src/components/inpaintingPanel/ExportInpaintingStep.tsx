import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui";

type ExportInpaintingStepProps = {
  hasCurrentChapter: boolean;
  hasSelectedPage: boolean;
  inpaintedPageCount: number;
  jobActive: boolean;
  onExportChapter: () => void;
  onExportPage: () => void;
  onGoToRetouch: () => void;
};

export function ExportInpaintingStep({
  hasCurrentChapter,
  hasSelectedPage,
  inpaintedPageCount,
  jobActive,
  onExportChapter,
  onExportPage,
  onGoToRetouch,
}: ExportInpaintingStepProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="inpaint-step-body">
      <p className="inpaint-step-lead">{t("inpainting.export.description")}</p>
      <div className="inpaint-group">
        <div className="inpaint-group-head">
          <h3>{t("inpainting.export.result")}</h3>
          <small>
            {t("inpainting.export.pagesSaved", { count: inpaintedPageCount })}
          </small>
        </div>
        <div className="inpainting-action-grid">
          <Button
            variant="primary"
            fullWidth
            disabled={!hasSelectedPage || jobActive}
            onClick={onExportPage}
          >
            {t("common.thisPage")}
          </Button>
          <Button
            variant="primary"
            fullWidth
            disabled={!hasCurrentChapter || jobActive}
            onClick={onExportChapter}
          >
            {t("inpainting.export.allPages")}
          </Button>
        </div>
      </div>
      <div className="inpaint-step-nav">
        <Button variant="ghost" onClick={onGoToRetouch}>
          {t("inpainting.export.backRetouch")}
        </Button>
        <span />
      </div>
    </div>
  );
}
