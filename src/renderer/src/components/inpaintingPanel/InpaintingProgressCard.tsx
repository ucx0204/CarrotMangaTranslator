import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { JobState } from "../../../../shared/jobTypes";
import type { ProgressSnapshot } from "../../lib/jobProgress";
import { JobProgressReadout } from "../JobProgressReadout";
import { Button } from "../ui/Button";

type InpaintingProgressCardProps = {
  jobState: JobState;
  progressSnapshot: ProgressSnapshot | null;
  onCancel: () => void;
};

export function InpaintingProgressCard({
  jobState,
  progressSnapshot,
  onCancel,
}: InpaintingProgressCardProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className={`inpainting-progress-card ${jobState.status}`}>
      <JobProgressReadout
        jobState={{
          ...jobState,
          // Inpainting always has something to say about the stage, so the
          // shared readout renders that instead of an empty detail line.
          detail: resolveProgressCardDetail(jobState, t),
        }}
        progressSnapshot={progressSnapshot}
      />
      {isCancellableInpaintingJob(jobState) ? (
        <Button variant="danger" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      ) : null}
    </div>
  );
}

function resolveProgressCardDetail(
  jobState: JobState,
  t: TFunction<"components">,
): string {
  if (jobState.status === "completed" && jobState.detail) {
    return jobState.detail;
  }
  return (
    jobState.detail ??
    (Number.isFinite(jobState.pageTotal)
      ? t("inpainting.progress.processingPages", {
          count: jobState.pageTotal,
        })
      : t("inpainting.progress.inProgress"))
  );
}

function isCancellableInpaintingJob(jobState: JobState): boolean {
  return jobState.status === "starting" || jobState.status === "running";
}
