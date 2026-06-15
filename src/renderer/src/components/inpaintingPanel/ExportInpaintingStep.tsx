import React from "react";
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
  return (
    <div className="inpaint-step-body">
      <p className="inpaint-step-lead">
        블록의 폰트·색·위치를 정리한 뒤, 번역이 얹힌 PNG로 내보냅니다.
      </p>
      <div className="inpaint-group">
        <div className="inpaint-group-head">
          <h3>결과 출력</h3>
          <small>{inpaintedPageCount}페이지 저장됨</small>
        </div>
        <div className="inpainting-action-grid">
          <Button
            variant="primary"
            fullWidth
            disabled={!hasSelectedPage || jobActive}
            onClick={onExportPage}
          >
            이 페이지
          </Button>
          <Button
            variant="primary"
            fullWidth
            disabled={!hasCurrentChapter || jobActive}
            onClick={onExportChapter}
          >
            전체 페이지
          </Button>
        </div>
      </div>
      <div className="inpaint-step-nav">
        <Button variant="ghost" onClick={onGoToRetouch}>
          ← 보정
        </Button>
        <span />
      </div>
    </div>
  );
}
