import React from "react";
import { useTranslation } from "react-i18next";
import type { ResearchJobStage } from "../../../../shared/jobTypes";
import type { StyleGuideResearchProgress } from "./useStyleGuideInternetResearch";

const RESEARCH_STAGES: readonly ResearchJobStage[] = [
  "preparing",
  "planning",
  "searching",
  "synthesizing",
  "auditing",
  "finalizing",
];

export function StyleGuideResearchProgressContent({
  progress,
}: {
  progress: StyleGuideResearchProgress;
}): React.JSX.Element {
  return (
    <>
      <ResearchProgressHero progress={progress} />
      <ResearchStageList activeStage={progress.stage} />
      <ResearchCreditMeter progress={progress} />
      <ResearchActivityPanel progress={progress} />
    </>
  );
}

export function StyleGuideResearchEngineBadge({
  engine,
}: Pick<StyleGuideResearchProgress, "engine">): React.JSX.Element {
  const { t } = useTranslation("components");
  const key =
    engine === "tavily"
      ? "styleGuide.analysis.engines.tavily"
      : "styleGuide.analysis.engines.codex";
  return <span className="style-guide-research-progress-engine">{t(key)}</span>;
}

export function StyleGuideResearchElapsed({
  startedAt,
}: {
  startedAt: number;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const elapsedSeconds = useElapsedSeconds(startedAt);
  return (
    <span className="style-guide-research-progress-elapsed">
      {t("styleGuide.research.progress.elapsed", {
        time: formatElapsedTime(elapsedSeconds),
      })}
    </span>
  );
}

function ResearchProgressHero({
  progress,
}: {
  progress: StyleGuideResearchProgress;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const titleKey = progress.cancelling
    ? "styleGuide.research.progress.cancelling"
    : `styleGuide.research.progress.stages.${progress.stage}.title`;
  const descriptionKey = progress.cancelling
    ? "styleGuide.research.progress.cancellingDescription"
    : `styleGuide.research.progress.stages.${progress.stage}.description`;
  return (
    <section className="style-guide-research-progress-hero" aria-live="polite">
      <div className="style-guide-research-progress-orbit" aria-hidden="true">
        <span />
      </div>
      <div className="style-guide-research-progress-copy">
        <span className="style-guide-research-progress-work">
          {progress.researchTitle}
        </span>
        <h3>{t(titleKey)}</h3>
        <p>{t(descriptionKey)}</p>
      </div>
    </section>
  );
}

function ResearchStageList({
  activeStage,
}: {
  activeStage: ResearchJobStage;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const currentIndex = RESEARCH_STAGES.indexOf(activeStage);
  return (
    <ol
      className="style-guide-research-progress-stages"
      aria-label={t("styleGuide.research.progress.stageLabel")}
    >
      {RESEARCH_STAGES.map((stage, index) => {
        const state = resolveStageState(index, currentIndex);
        return (
          <li key={stage} data-state={state}>
            <span className="style-guide-research-progress-stage-marker">
              {state === "complete" ? "✓" : index + 1}
            </span>
            <span>
              {t(`styleGuide.research.progress.stages.${stage}.short`)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function resolveStageState(
  index: number,
  currentIndex: number,
): "complete" | "active" | "pending" {
  if (index < currentIndex) return "complete";
  return index === currentIndex ? "active" : "pending";
}

function ResearchCreditMeter({
  progress,
}: {
  progress: StyleGuideResearchProgress;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  const metrics = progress.metrics;
  const limit = metrics?.creditLimit ?? 0;
  if (progress.engine !== "tavily" || !Number.isFinite(limit) || limit <= 0) {
    return null;
  }
  const used = metrics?.creditsUsed ?? 0;
  const ratio = Math.min(1, Math.max(0, used / limit));
  return (
    <section className="style-guide-research-progress-meter">
      <div>
        <span>{t("styleGuide.research.progress.creditUsage")}</span>
        <strong>
          {t("styleGuide.research.progress.creditCount", { used, limit })}
        </strong>
      </div>
      <div
        className="style-guide-research-progress-track"
        role="progressbar"
        aria-label={t("styleGuide.research.progress.creditUsage")}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
      >
        <span style={{ width: `${ratio * 100}%` }} />
      </div>
    </section>
  );
}

function ResearchActivityPanel({
  progress,
}: {
  progress: StyleGuideResearchProgress;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="style-guide-research-progress-activity">
      <div className="style-guide-research-progress-section-head">
        <h4>{t("styleGuide.research.progress.activityTitle")}</h4>
        {progress.activities.length > 0 ? (
          <span>
            {t("styleGuide.research.progress.searchCount", {
              count:
                progress.activities.at(-1)?.queryIndex ??
                progress.activities.length,
            })}
          </span>
        ) : null}
      </div>
      {progress.activities.length > 0 ? (
        <ul>
          {progress.activities.map((activity) => (
            <li key={activity.id}>
              <span className="style-guide-research-progress-activity-dot" />
              <div>
                <strong>{activity.query}</strong>
                <span>
                  {activity.resultCount === undefined
                    ? t("styleGuide.research.progress.searching")
                    : t("styleGuide.research.progress.sourcesFound", {
                        count: activity.resultCount,
                      })}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="style-guide-research-progress-current">
          <span className="style-guide-research-progress-pulse" />
          <div>
            <strong>
              {progress.progressText ||
                t(
                  `styleGuide.research.progress.stages.${progress.stage}.title`,
                )}
            </strong>
            <span>
              {progress.detail ||
                t("styleGuide.research.progress.waitingForActivity")}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

function useElapsedSeconds(startedAt: number): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return Math.max(0, Math.floor((now - startedAt) / 1_000));
}

function formatElapsedTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
