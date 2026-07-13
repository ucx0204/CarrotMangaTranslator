import React from "react";
import { useTranslation } from "react-i18next";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { JobState } from "../../../shared/jobTypes";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { isSizableRetouchTool, type RetouchTool } from "../lib/stageTool";
import { AutoInpaintingStep } from "./inpaintingPanel/AutoInpaintingStep";
import { InpaintingProgressCard } from "./inpaintingPanel/InpaintingProgressCard";
import { RetouchInpaintingStep } from "./inpaintingPanel/RetouchInpaintingStep";

export { DisplayControlPanel } from "./inpaintingPanel/DisplayControlPanel";

type CommonInspectorProps = {
  jobActive: boolean;
  jobState: JobState;
  progressSnapshot: ProgressSnapshot | null;
  onCancelJob: () => void;
};

type AutoInpaintingInspectorProps = CommonInspectorProps & {
  mode: "auto";
  currentChapter: ChapterSnapshot | null;
  selectedPage: MangaPage | null;
  inpaintedPageCount: number;
  pageTargetCount: number;
  pendingPageCount: number;
  pendingTargetCount: number;
  peekAvailable: boolean;
  peeking: boolean;
  onPeekToggle: () => void;
  onRevertChapter: () => void;
  onRevertPage: () => void;
  onShowGuide: () => void;
};

type RetouchInspectorProps = CommonInspectorProps & {
  mode: "retouch";
  tool: RetouchTool;
  brushColor: string;
  brushRadius: number;
  canRedo: boolean;
  canUndo: boolean;
  hasSelectedPage: boolean;
  maskStrokeCount: number;
  onBrushColorChange: (value: string) => void;
  onBrushRadiusChange: (value: number) => void;
  onClearPatternMask: () => void;
  onRedoRetouch: () => void;
  onRunDrawnPattern: () => void;
  onUndoRetouch: () => void;
};

export type InpaintingControlPanelProps =
  | AutoInpaintingInspectorProps
  | RetouchInspectorProps;

/**
 * Contextual inpainting inspector. The workflow stepper deliberately lives
 * nowhere: choosing a canvas tool or opening automatic erase is the mode.
 */
export function InpaintingControlPanel(
  props: InpaintingControlPanelProps,
): React.JSX.Element {
  const activeInpaintingJob =
    props.jobState.kind === "inpainting" &&
    (props.jobState.status === "starting" ||
      props.jobState.status === "running");

  return (
    <section className="inpainting-panel inpainting-inspector">
      <InspectorHeader props={props} />

      {props.mode === "auto" ? (
        <InpaintingCountBadges
          inpaintedPageCount={props.inpaintedPageCount}
          pageTargetCount={props.pageTargetCount}
          pendingTargetCount={props.pendingTargetCount}
        />
      ) : null}

      {activeInpaintingJob ? (
        <InpaintingProgressCard
          jobState={props.jobState}
          progressSnapshot={props.progressSnapshot}
          onCancel={props.onCancelJob}
        />
      ) : null}

      <InspectorBody props={props} />
    </section>
  );
}

function InspectorHeader({
  props,
}: {
  props: InpaintingControlPanelProps;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="inpainting-inspector-head">
      <div>
        <small>{t("inpainting.inspector.eyebrow")}</small>
        <h2>
          {t(
            props.mode === "auto"
              ? "inpainting.inspector.autoTitle"
              : "inpainting.inspector.retouchTitle",
          )}
        </h2>
      </div>
      {props.mode === "auto" ? (
        <button
          type="button"
          className="inpainting-guide-button compact"
          onClick={props.onShowGuide}
        >
          {t("inpainting.steps.guide")}
        </button>
      ) : null}
    </div>
  );
}

function InspectorBody({
  props,
}: {
  props: InpaintingControlPanelProps;
}): React.JSX.Element {
  return props.mode === "auto" ? (
    <AutoInspectorBody props={props} />
  ) : (
    <RetouchInspectorBody props={props} />
  );
}

function AutoInspectorBody({
  props,
}: {
  props: AutoInpaintingInspectorProps;
}): React.JSX.Element {
  return (
    <AutoInpaintingStep
      hasCurrentChapter={Boolean(props.currentChapter)}
      inpaintedPageCount={props.inpaintedPageCount}
      jobActive={props.jobActive}
      onPeekToggle={props.onPeekToggle}
      onRevertChapter={props.onRevertChapter}
      onRevertPage={props.onRevertPage}
      peekAvailable={props.peekAvailable}
      peeking={props.peeking}
      pendingPages={props.pendingPageCount}
      pendingTargetCount={props.pendingTargetCount}
      selectedPageInpainted={Boolean(props.selectedPage?.inpaintedImagePath)}
      totalPages={props.currentChapter?.pages.length ?? 0}
    />
  );
}

function RetouchInspectorBody({
  props,
}: {
  props: RetouchInspectorProps;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <RetouchInpaintingStep
      activeToolLabel={t(`inpainting.tools.${props.tool}`)}
      brushColor={props.brushColor}
      brushRadius={props.brushRadius}
      canRedo={props.canRedo}
      canUndo={props.canUndo}
      hasSelectedPage={props.hasSelectedPage}
      jobActive={props.jobActive}
      maskStrokeCount={props.maskStrokeCount}
      onBrushColorChange={props.onBrushColorChange}
      onBrushRadiusChange={props.onBrushRadiusChange}
      onClearPatternMask={props.onClearPatternMask}
      onRedoRetouch={props.onRedoRetouch}
      onRunDrawnPattern={props.onRunDrawnPattern}
      onUndoRetouch={props.onUndoRetouch}
      sizableTool={isSizableRetouchTool(props.tool)}
      tool={props.tool}
    />
  );
}

function InpaintingCountBadges({
  inpaintedPageCount,
  pageTargetCount,
  pendingTargetCount,
}: {
  inpaintedPageCount: number;
  pageTargetCount: number;
  pendingTargetCount: number;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="inpainting-counts">
      <span className="type-stat nonsolid">
        {t("inpainting.counts.thisPage", { count: pageTargetCount })}
      </span>
      <span className="type-stat nonsolid">
        {t("inpainting.counts.remaining", { count: pendingTargetCount })}
      </span>
      <span className="type-stat review">
        {t("inpainting.counts.completed", { count: inpaintedPageCount })}
      </span>
    </div>
  );
}
