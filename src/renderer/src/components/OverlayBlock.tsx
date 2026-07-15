import React from "react";
import { IconEraserOff } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { normalizeCurveLayout } from "../../../shared/blockTransforms";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { DragMode } from "../hooks/workspacePointerGeometry";
import type { ViewportSize } from "../lib/overlayLayout";
import { CurveText } from "./CurveText";
import { OverlayText } from "./OverlayText";
import {
  resolveOverlayBlockRenderModel,
  type OverlayBlockRenderModel,
} from "./overlayBlockModel";
import {
  OverlayTransformControls,
  type BlockTransformMode,
} from "./OverlayTransformControls";
import "./overlayTransforms.css";

type OverlayBlockProps = {
  block: TranslationBlock;
  pageSize: ViewportSize;
  stageSize: ViewportSize;
  selected: boolean;
  multiSelected?: boolean;
  showChrome: boolean;
  textLayoutStageSize: ViewportSize | null;
  textVisible?: boolean;
  pointerDisabled?: boolean;
  transformMode?: BlockTransformMode;
  onPointerDown: (event: React.PointerEvent) => void;
  onResizePointerDown: (event: React.PointerEvent) => void;
  onTransformPointerDown?: (event: React.PointerEvent, mode: DragMode) => void;
};

export function OverlayBlock(props: OverlayBlockProps): React.JSX.Element {
  const selectedMode =
    props.transformMode ?? (props.selected ? "select" : undefined);
  const excluded = Boolean(props.block.inpaintExcluded);
  const model = resolveOverlayBlockRenderModel({
    ...props,
    excluded,
    multiSelected: props.multiSelected ?? false,
    pointerDisabled: props.pointerDisabled ?? false,
    textVisible: props.textVisible ?? true,
    transformMode: selectedMode,
  });
  const pointerDisabled = props.pointerDisabled ?? false;
  return (
    <div
      className={model.outerClassName}
      style={model.outerStyle}
      onPointerDown={pointerDisabled ? undefined : props.onPointerDown}
    >
      <OverlayBlockContent
        block={props.block}
        model={model}
        textVisible={props.textVisible ?? true}
      />
      <OverlayExcludeControl excluded={excluded} />
      <OverlayBlockControls
        block={props.block}
        model={model}
        mode={selectedMode}
        onPointerDown={
          props.onTransformPointerDown ??
          ((event) => props.onResizePointerDown(event))
        }
        pointerDisabled={pointerDisabled}
        selected={props.selected}
        textVisible={props.textVisible ?? true}
      />
    </div>
  );
}

function OverlayBlockContent({
  block,
  model,
  textVisible,
}: {
  block: TranslationBlock;
  model: OverlayBlockRenderModel;
  textVisible: boolean;
}): React.JSX.Element {
  return (
    <div className="overlay-transform-content" style={model.contentStyle}>
      {model.showChromeLayer ? (
        <div className="overlay-block-chrome" style={model.chromeStyle} />
      ) : null}
      <OverlayBlockText block={block} model={model} visible={textVisible} />
    </div>
  );
}

function OverlayBlockText({
  block,
  model,
  visible,
}: {
  block: TranslationBlock;
  model: OverlayBlockRenderModel;
  visible: boolean;
}): React.JSX.Element | null {
  if (!visible) return null;
  if (model.curveRenderable && block.curveLayout) {
    return (
      <CurveText
        block={block}
        curveLayout={normalizeCurveLayout(block.curveLayout)}
        displayText={model.displayText}
        layout={model.layout}
      />
    );
  }
  return (
    <OverlayText
      block={block}
      displayText={model.displayText}
      layout={model.layout}
      renderDirection={model.renderDirection}
    />
  );
}

function OverlayBlockControls({
  block,
  model,
  mode,
  onPointerDown,
  pointerDisabled,
  selected,
  textVisible,
}: {
  block: TranslationBlock;
  model: OverlayBlockRenderModel;
  mode?: BlockTransformMode;
  onPointerDown: (event: React.PointerEvent, mode: DragMode) => void;
  pointerDisabled: boolean;
  selected: boolean;
  textVisible: boolean;
}): React.JSX.Element | null {
  if (!selected || !textVisible || pointerDisabled || !mode) return null;
  return (
    <OverlayTransformControls
      block={block}
      height={model.layout.rect.height}
      mode={mode}
      onPointerDown={onPointerDown}
      showCurveGuide={model.curveRenderable}
      width={model.layout.rect.width}
    />
  );
}

function OverlayExcludeControl({
  excluded,
}: {
  excluded: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  return excluded ? (
    <span
      className="overlay-excluded-badge"
      role="img"
      aria-label={t("overlay.excludedFromInpainting")}
    >
      <IconEraserOff size={14} stroke={2.4} aria-hidden="true" />
    </span>
  ) : null;
}
