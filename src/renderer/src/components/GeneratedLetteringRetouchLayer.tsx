import { useLetteringStroke } from "../hooks/useLetteringStroke";
import React from "react";
import { LetteringMaskOverlay } from "./LetteringMaskOverlay";
import { useBlockInteractionPreview } from "../lib/workspaceInteractionPreview";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { LetteringTool } from "../../../shared/generatedLetteringMaskTypes";
import type { WorkspaceInteractionPreviewStore } from "../lib/workspaceInteractionPreview";
import styles from "./GeneratedLetteringRetouchLayer.module.css";

export type LetteringRetouchProps = {
  tool: LetteringTool;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
};

export function GeneratedLetteringRetouchLayer({
  page,
  selectedBlockId,
  controls,
  preview,
}: {
  page: MangaPage;
  selectedBlockId: string | null;
  controls: LetteringRetouchProps;
  preview: WorkspaceInteractionPreviewStore;
}): React.JSX.Element | null {
  const block = page.blocks.find((item) => item.id === selectedBlockId);
  return block?.generatedLettering && controls.tool.blockId === block.id ? (
    <LetteringStrokeSurface
      key={`${page.id}:${block.id}`}
      page={page}
      block={block}
      controls={controls}
      preview={preview}
    />
  ) : null;
}

function LetteringStrokeSurface({
  page,
  block,
  controls,
  preview,
}: {
  page: MangaPage;
  block: TranslationBlock;
  controls: LetteringRetouchProps;
  preview: WorkspaceInteractionPreviewStore;
}): React.JSX.Element {
  const previewBlock = useBlockInteractionPreview(preview, block.id);
  const { cursor, setCursor, stroke, cancel, update, start, end } =
    useLetteringStroke(page, block, controls, preview);
  const { tool } = controls;
  return (
    <svg
      className={styles.surface}
      viewBox="0 0 1000 1000"
      preserveAspectRatio="none"
      onPointerDown={start}
      onPointerMove={update}
      onPointerUp={end}
      onPointerCancel={(event) => {
        event.stopPropagation();
        cancel();
      }}
      onLostPointerCapture={cancel}
      onPointerLeave={() => {
        if (!stroke.current) setCursor(null);
      }}
    >
      <LetteringMaskOverlay
        block={previewBlock ?? block}
        page={page}
        tool={tool}
      />
      {cursor ? (
        tool.shape === "circle" ? (
          <ellipse
            className={styles.cursor}
            cx={cursor.x}
            cy={cursor.y}
            rx={(tool.size / page.width) * 500}
            ry={(tool.size / page.height) * 500}
          />
        ) : (
          <rect
            className={styles.cursor}
            x={cursor.x - (tool.size / page.width) * 500}
            y={cursor.y - (tool.size / page.height) * 500}
            width={(tool.size / page.width) * 1000}
            height={(tool.size / page.height) * 1000}
          />
        )
      ) : null}
    </svg>
  );
}
