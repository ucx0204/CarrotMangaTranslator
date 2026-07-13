import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui";
import { EyeIcon } from "../ui/icons";

type AutoInpaintingStepProps = {
  hasCurrentChapter: boolean;
  inpaintedPageCount: number;
  jobActive: boolean;
  onPeekToggle: () => void;
  onRevertChapter: () => void;
  onRevertPage: () => void;
  peekAvailable: boolean;
  peeking: boolean;
  pendingPages: number;
  pendingTargetCount: number;
  selectedPageInpainted: boolean;
  totalPages: number;
};

export function AutoInpaintingStep({
  hasCurrentChapter,
  inpaintedPageCount,
  jobActive,
  onPeekToggle,
  onRevertChapter,
  onRevertPage,
  peekAvailable,
  peeking,
  pendingPages,
  pendingTargetCount,
  selectedPageInpainted,
  totalPages,
}: AutoInpaintingStepProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="inpaint-step-body">
      <p className="inpaint-step-lead">{t("inpainting.auto.description")}</p>
      <AutoInpaintingSummaryCard
        hasCurrentChapter={hasCurrentChapter}
        jobActive={jobActive}
        onPeekToggle={onPeekToggle}
        peekAvailable={peekAvailable}
        peeking={peeking}
        pendingPages={pendingPages}
        pendingTargetCount={pendingTargetCount}
        totalPages={totalPages}
      />
      <AutoInpaintingRevertActions
        inpaintedPageCount={inpaintedPageCount}
        jobActive={jobActive}
        onRevertChapter={onRevertChapter}
        onRevertPage={onRevertPage}
        selectedPageInpainted={selectedPageInpainted}
      />
    </div>
  );
}

function AutoInpaintingSummaryCard({
  hasCurrentChapter,
  jobActive,
  onPeekToggle,
  peekAvailable,
  peeking,
  pendingPages,
  pendingTargetCount,
  totalPages,
}: Pick<
  AutoInpaintingStepProps,
  | "hasCurrentChapter"
  | "jobActive"
  | "onPeekToggle"
  | "peekAvailable"
  | "peeking"
  | "pendingPages"
  | "pendingTargetCount"
  | "totalPages"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="inpainting-run-card">
      <span className="inpainting-run-meta">
        {hasCurrentChapter
          ? t("inpainting.auto.remainingSummary", {
              pendingPages,
              totalPages,
              blockCount: pendingTargetCount,
            })
          : t("inpainting.auto.noOpenChapter")}
      </span>
      <button
        type="button"
        className={`peek-button ${peeking ? "active" : ""}`}
        disabled={!peekAvailable || jobActive}
        aria-pressed={peeking}
        onClick={onPeekToggle}
      >
        <EyeIcon size={16} />
        <span>
          {t(
            peeking
              ? "inpainting.auto.showingOriginal"
              : "inpainting.auto.compareOriginal",
          )}
        </span>
      </button>
      <p className="inpainting-hint">{t("inpainting.auto.excludeHint")}</p>
    </div>
  );
}

function AutoInpaintingRevertActions({
  inpaintedPageCount,
  jobActive,
  onRevertChapter,
  onRevertPage,
  selectedPageInpainted,
}: Pick<
  AutoInpaintingStepProps,
  | "inpaintedPageCount"
  | "jobActive"
  | "onRevertChapter"
  | "onRevertPage"
  | "selectedPageInpainted"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="inpaint-revert">
      <span className="inpaint-revert-label">
        {t("inpainting.auto.revert")}
      </span>
      <div className="inpaint-revert-row">
        <Button
          size="sm"
          variant="ghost"
          disabled={!selectedPageInpainted || jobActive}
          onClick={onRevertPage}
        >
          {t("common.thisPage")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!inpaintedPageCount || jobActive}
          onClick={onRevertChapter}
        >
          {t("common.all")}
        </Button>
      </div>
    </div>
  );
}
