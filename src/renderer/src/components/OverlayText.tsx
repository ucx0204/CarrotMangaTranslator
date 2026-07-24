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
          ? renderFixedHorizontalLines(layout.lines)
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

function renderFixedHorizontalLines(lines: BlockTextLine[]): React.ReactNode {
  return lines.map((line, lineIndex) => (
    <span
      className="overlay-text-line"
      key={lineIndex}
      style={{ display: "block", whiteSpace: "pre" }}
    >
      {line.runs.length > 0
        ? line.runs.map((run, runIndex) => renderTextRun(run, runIndex))
        : "\u00a0"}
    </span>
  ));
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
