import React from "react";
import type {
  RenderTextDirection,
  TranslationBlock,
} from "../../../shared/textTypes";
import { parseRichText } from "../../../shared/richTextMarkup";
import type { BlockFontCatalog } from "../lib/fonts";
import type { BlockTextLayout } from "../lib/overlayLayout";
import type { BlockTextLine } from "../lib/overlayTextWrapping";
import {
  resolveOverlayTextContentStyle,
  resolveOverlayTextWrapStyle,
} from "./overlayTextStyles";

export function OverlayText({
  block,
  displayText,
  fontCatalog,
  layout,
  renderDirection,
}: {
  block: TranslationBlock;
  displayText: string;
  fontCatalog: BlockFontCatalog;
  layout: BlockTextLayout;
  renderDirection: RenderTextDirection;
}): React.JSX.Element {
  return (
    <div
      className="overlay-text"
      style={resolveOverlayTextWrapStyle(block, layout, fontCatalog)}
    >
      <span
        className="overlay-text-content"
        style={resolveOverlayTextContentStyle(block, layout, renderDirection)}
      >
        {layout.lines
          ? renderFixedLines(block, layout, renderDirection)
          : renderParsedTextRuns(block, displayText)}
      </span>
    </div>
  );
}

function renderParsedTextRuns(
  block: TranslationBlock,
  displayText: string,
): React.ReactNode {
  const { runs } = parseRichText(
    displayText,
    Boolean(block.bold),
    Boolean(block.italic),
  );
  return runs.map((run, index) => renderTextRun(run, index));
}

function renderFixedLines(
  block: TranslationBlock,
  layout: BlockTextLayout,
  renderDirection: RenderTextDirection,
): React.ReactNode {
  return layout.lines?.map((line, lineIndex) => (
    <span
      className="overlay-text-line"
      data-bubble-direction={line.slot ? renderDirection : undefined}
      data-bubble-slot={line.slot ? "" : undefined}
      key={lineIndex}
      style={resolveFixedLineStyle(
        line,
        block,
        layout.fontSizePx,
        renderDirection,
      )}
    >
      {line.runs.length > 0
        ? line.runs.map((run, runIndex) => renderTextRun(run, runIndex))
        : "\u00a0"}
    </span>
  ));
}

function resolveFixedLineStyle(
  line: BlockTextLine,
  block: TranslationBlock,
  fontSizePx: number,
  renderDirection: RenderTextDirection,
): React.CSSProperties {
  if (!line.slot) return { display: "block", whiteSpace: "pre" };
  if (renderDirection === "vertical") {
    return {
      display: "block",
      height: line.slot.availableWidth,
      left: line.slot.blockOffsetPx,
      position: "absolute",
      textOrientation: "upright",
      top: line.slot.inlineOffsetPx,
      whiteSpace: "pre",
      width: fontSizePx * block.lineHeight,
      writingMode: "vertical-rl",
    };
  }
  return {
    display: "block",
    left: line.slot.inlineOffsetPx,
    position: "absolute",
    top: line.slot.blockOffsetPx,
    whiteSpace: "pre",
    width: line.slot.availableWidth,
  };
}

function renderTextRun(
  run: { text: string; bold: boolean; italic: boolean },
  key: React.Key,
): React.JSX.Element {
  return (
    <span
      key={key}
      style={{
        fontWeight: run.bold ? 800 : 400,
        fontStyle: run.italic ? "italic" : "normal",
      }}
    >
      {run.text}
    </span>
  );
}
