import { RegionReviewTextList } from "./RegionReviewTextList";
import React from "react";
import { useTranslation } from "react-i18next";
import { normalizedRegionToPixelRect } from "../../../shared/region";

import type { RegionReviewInput } from "../lib/regionReviewTypes";
import { Button } from "./ui/Button";

import { NumberField } from "./ui/NumberField";

import { SegmentedControl } from "./ui/SegmentedControl";
import { useContainedPageSize } from "./useContainedPageSize";
import { RegionReviewCanvas } from "./RegionReviewCanvas";
import type { RegionReviewTool } from "./useRegionReviewDrawing";
import type { useRegionReviewForm } from "./useRegionReviewForm";
import styles from "./RegionReviewEditor.module.css";
import { useRegionReviewNavigation } from "./useRegionReviewNavigation";

type Form = ReturnType<typeof useRegionReviewForm>;
export function RegionReviewEditor({
  props,
  form,
  source,
  setFailed,
}: {
  props: RegionReviewInput;
  form: Form;
  source: string;
  setFailed: (failed: boolean) => void;
}): React.JSX.Element {
  const viewport = React.useRef<HTMLDivElement>(null);
  const crop = normalizedRegionToPixelRect(props.bbox, props.page, 8);
  const fit = useContainedPageSize(viewport, { width: crop.w, height: crop.h });
  const [zoom, setZoom] = React.useState(0);
  const [tool, setTool] = React.useState<RegionReviewTool>("bounds");
  const [shape, setShape] = React.useState<"circle" | "square">("circle");
  const [size, setSize] = React.useState(24);
  const disabled = props.busy || form.preparing;
  const actualZoom = zoom || (fit.width * 100) / crop.w;
  const navigation = useRegionReviewNavigation({
    viewport,
    zoom: actualZoom,
    setZoom,
    tool,
    setTool,
    setSize,
    disabled,
    form,
  });
  return (
    <div className={styles.editor} {...navigation.handlers}>
      <ReviewTools
        tool={navigation.tool}
        setTool={setTool}
        shape={shape}
        setShape={setShape}
        size={size}
        setSize={setSize}
        disabled={disabled}
        form={form}
        actualZoom={actualZoom}
        setZoom={setZoom}
      />
      <RegionReviewCanvas
        page={props.page}
        crop={crop}
        source={source}
        form={form}
        tool={navigation.tool}
        shape={shape}
        size={size}
        zoom={actualZoom}
        viewport={viewport}
        disabled={disabled}
        setFailed={setFailed}
      />
      {props.review ? (
        <RegionReviewTextList
          review={props.review}
          form={form}
          disabled={disabled}
          crop={crop}
          editSourceText={props.editSourceText}
        />
      ) : null}
    </div>
  );
}

function ReviewTools(props: ReviewToolsProps) {
  const {
    tool,
    setTool,
    shape,
    setShape,
    size,
    setSize,
    disabled,
    form,
    actualZoom,
    setZoom,
  } = props;
  const { t } = useTranslation("components");
  return (
    <div className={styles.tools}>
      <ReviewToolSelect tool={tool} setTool={setTool} disabled={disabled} />
      {tool === "hide" || tool === "restore" || tool === "paint" ? (
        <>
          <SegmentedControl
            singleRow
            ariaLabel={t("letteringBrush.shape")}
            value={shape}
            onChange={setShape}
            disabled={disabled}
            options={(["circle", "square"] as const).map((id) => ({
              id,
              label: t(`letteringBrush.${id}`),
            }))}
          />
          <NumberField
            className={styles.number}
            variant="framed"
            ariaLabel={t("letteringBrush.size")}
            min={1}
            max={400}
            value={size}
            onValueChange={setSize}
            unit="px"
            disabled={disabled}
          />
        </>
      ) : null}
      <Button
        size="sm"
        disabled={disabled || !form.canUndo}
        onClick={form.undo}
        title={`${t("imageRedaction.undo")} (Ctrl+Z)`}
        aria-keyshortcuts="Control+z Meta+z"
      >
        {t("imageRedaction.undo")}
      </Button>
      <Button
        size="sm"
        disabled={disabled || !form.canRedo}
        onClick={form.redo}
        title={`${t("imageRedaction.redo")} (Ctrl+Shift+Z / Ctrl+Y)`}
        aria-keyshortcuts="Control+Shift+z Control+y Meta+Shift+z"
      >
        {t("imageRedaction.redo")}
      </Button>
      <ReviewZoom actualZoom={actualZoom} setZoom={setZoom} />
    </div>
  );
}

type ReviewToolsProps = {
  tool: RegionReviewTool;
  setTool: (tool: RegionReviewTool) => void;
  shape: "circle" | "square";
  setShape: (shape: "circle" | "square") => void;
  size: number;
  setSize: (size: number) => void;
  disabled?: boolean;
  form: Form;
  actualZoom: number;
  setZoom: (zoom: number) => void;
};

function ReviewZoom({
  actualZoom,
  setZoom,
}: Pick<ReviewToolsProps, "actualZoom" | "setZoom">) {
  const { t } = useTranslation("components");
  return (
    <div className={styles.zoom}>
      <NumberField
        className={styles.number}
        variant="framed"
        ariaLabel={t("imageRedaction.zoom")}
        min={1}
        max={800}
        value={actualZoom}
        onValueChange={setZoom}
        unit="%"
      />
      <Button size="sm" onClick={() => setZoom(0)}>
        {t("codexFonts.fit")}
      </Button>
    </div>
  );
}

function ReviewToolSelect({
  tool,
  setTool,
  disabled,
}: Pick<ReviewToolsProps, "tool" | "setTool" | "disabled">) {
  const { t } = useTranslation("components");
  return (
    <SegmentedControl
      singleRow
      ariaLabel={t("regionOptions.editTool")}
      value={tool}
      onChange={setTool}
      disabled={disabled}
      options={(
        ["bounds", "add", "paint", "hide", "restore", "pan"] as const
      ).map((id) => ({
        id,
        label: t(`regionOptions.${id}`),
        shortcut: {
          bounds: "V",
          add: "R",
          paint: "P",
          hide: "B",
          restore: "E",
          pan: "H",
        }[id],
      }))}
    />
  );
}
