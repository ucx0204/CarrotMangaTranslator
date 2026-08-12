import React from "react";
import { useTranslation } from "react-i18next";
import type { JobState } from "../../../shared/jobTypes";
import type { ProgressSnapshot } from "../lib/jobProgress";
import {
  isPaintColorRetouchTool,
  isSizableRetouchTool,
  type RetouchTool,
} from "../lib/stageTool";
import { InpaintingProgressCard } from "./inpaintingPanel/InpaintingProgressCard";
import { RetouchInpaintingStep } from "./inpaintingPanel/RetouchInpaintingStep";

type CommonInspectorProps = {
  jobActive: boolean;
  jobState: JobState;
  progressSnapshot: ProgressSnapshot | null;
  onCancelJob: () => void;
};

type RetouchInspectorProps = CommonInspectorProps & {
  mode: "retouch";
  tool: RetouchTool;
  brushColor: string;
  brushRadius: number;
  hasSelectedPage: boolean;
  maskStrokeCount: number;
  onBrushColorChange: (value: string) => void;
  onBrushRadiusChange: (value: number) => void;
  onAdjustPatternMask: (deltaPx: number) => void;
  onClearPatternMask: () => void;
  onRunDrawnPattern: () => void;
};

export type InpaintingControlPanelProps = RetouchInspectorProps;

/** Settings for whichever manual correction tool currently owns the canvas. */
export function InpaintingControlPanel(
  props: InpaintingControlPanelProps,
): React.JSX.Element {
  const activeInpaintingJob =
    props.jobState.kind === "inpainting" &&
    (props.jobState.status === "starting" ||
      props.jobState.status === "running");

  return (
    <section className="inpainting-panel inpainting-inspector">
      <InspectorHeader />

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

function InspectorHeader(): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="inpainting-inspector-head">
      <div>
        <small>{t("inpainting.inspector.eyebrow")}</small>
        <h2>{t("inpainting.inspector.retouchTitle")}</h2>
      </div>
    </div>
  );
}

function InspectorBody({
  props,
}: {
  props: InpaintingControlPanelProps;
}): React.JSX.Element {
  return <RetouchInspectorBody props={props} />;
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
      colorTool={isPaintColorRetouchTool(props.tool)}
      hasSelectedPage={props.hasSelectedPage}
      jobActive={props.jobActive}
      maskStrokeCount={props.maskStrokeCount}
      onBrushColorChange={props.onBrushColorChange}
      onBrushRadiusChange={props.onBrushRadiusChange}
      onAdjustPatternMask={props.onAdjustPatternMask}
      onClearPatternMask={props.onClearPatternMask}
      onRunDrawnPattern={props.onRunDrawnPattern}
      sizableTool={isSizableRetouchTool(props.tool)}
      tool={props.tool}
    />
  );
}
