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
  createTextRunStyleResolver,
  type TextRunStyleResolver,
} from "../lib/textStyleRunResolution";
import {
  resolveOverlayTextContentStyle,
  resolveOverlayTextWrapStyle,
} from "./overlayTextStyles";
import { TextWithVerticalSpacing } from "./VerticalTextSpacing";

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
  const parsed = parseRichText(
    displayText,
    Boolean(block.bold),
    Boolean(block.italic),
  );
  const blockOpacityAtRoot = !parsed.runs.some(
    (run) => run.opacity !== undefined,
  );
  const resolveRunStyle = createTextRunStyleResolver(
    block,
    layout.fontSizePx,
    fontCatalog,
  );
  return (
    <div
      className="overlay-text"
      style={resolveOverlayTextWrapStyle(
        block,
        layout,
        fontCatalog,
        blockOpacityAtRoot,
      )}
    >
      <span
        className="overlay-text-content"
        style={resolveOverlayTextContentStyle(block, layout, renderDirection)}
      >
        {layout.lines
          ? renderFixedLines(
              block,
              layout,
              renderDirection,
              resolveRunStyle,
              blockOpacityAtRoot,
            )
          : renderParsedTextRuns(
              parsed.runs,
              renderDirection,
              resolveRunStyle,
              blockOpacityAtRoot,
            )}
      </span>
    </div>
  );
}

function renderParsedTextRuns(
  runs: ReturnType<typeof parseRichText>["runs"],
  renderDirection: RenderTextDirection,
  resolveRunStyle: TextRunStyleResolver,
  blockOpacityAtRoot: boolean,
): React.ReactNode {
  return runs.map((run, index) =>
    renderTextRun(
      run,
      index,
      renderDirection,
      resolveRunStyle,
      blockOpacityAtRoot,
    ),
  );
}

function renderFixedLines(
  block: TranslationBlock,
  layout: BlockTextLayout,
  renderDirection: RenderTextDirection,
  resolveRunStyle: TextRunStyleResolver,
  blockOpacityAtRoot: boolean,
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
        ? line.runs.map((run, runIndex) =>
            renderTextRun(
              run,
              runIndex,
              renderDirection,
              resolveRunStyle,
              blockOpacityAtRoot,
            ),
          )
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
    const columnFontSizePx = line.runs.reduce(
      (largest, run) => Math.max(largest, run.renderedFontSizePx ?? fontSizePx),
      fontSizePx,
    );
    return {
      display: "block",
      height: line.slot.availableWidth,
      left: line.slot.blockOffsetPx,
      position: "absolute",
      textOrientation: "upright",
      top: line.slot.inlineOffsetPx,
      whiteSpace: "pre",
      width: columnFontSizePx * block.lineHeight,
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
  run: BlockTextLine["runs"][number],
  key: React.Key,
  renderDirection: RenderTextDirection,
  resolveRunStyle: TextRunStyleResolver,
  blockOpacityAtRoot: boolean,
): React.JSX.Element {
  const fallback = resolveRunStyle(run);
  return (
    <span
      key={key}
      style={{
        fontWeight: run.bold ? 800 : 400,
        fontStyle: run.italic ? "italic" : "normal",
        fontSize: `${run.renderedFontSizePx ?? fallback.fontSizePx}px`,
        fontFamily: run.renderedFontFamily ?? fallback.fontFamily,
        opacity: blockOpacityAtRoot
          ? 1
          : (run.renderedOpacity ?? fallback.opacity),
      }}
    >
      <TextWithVerticalSpacing direction={renderDirection} text={run.text} />
    </span>
  );
}
