import type { PointerEvent } from "react";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import { resolveEditableBlockBbox } from "../lib/blockFormatGeometry";
import type { DragHud, DragMode } from "../lib/workspaceInteractionTypes";
import {
  applyBlockDragResolution,
  applyBlockMoveDelta,
  type BlockDragResolution,
} from "./workspaceBlockDragModel";
import {
  describeDragBbox,
  type DragState,
  type PointerRect,
} from "./workspacePointerGeometry";

export type ActiveBlockDrag = {
  drag: DragState;
  latestValidResolution: BlockDragResolution | null;
  moveStartBlocks: readonly TranslationBlock[];
  page: MangaPage;
  pointerRect: PointerRect;
  pointerChanged: boolean;
};

export function startBlockDrag({
  block,
  event,
  mode,
  moveStartBlocks,
  page,
  pointerRect,
}: {
  block: TranslationBlock;
  event: Pick<PointerEvent, "clientX" | "clientY" | "pointerId">;
  mode: DragMode;
  moveStartBlocks: readonly TranslationBlock[];
  page: MangaPage;
  pointerRect: PointerRect;
}): ActiveBlockDrag {
  const pageSize = { width: page.width, height: page.height };
  const displayText = block.translatedText || block.sourceText || "...";
  const target = resolveEditableBlockBbox(block, pageSize, displayText);
  return {
    drag: {
      mode,
      blockId: block.id,
      startX: event.clientX,
      startY: event.clientY,
      startBbox: target.bbox,
      startBlock: block,
      pointerId: event.pointerId,
    },
    latestValidResolution: null,
    moveStartBlocks,
    page,
    pointerChanged: false,
    pointerRect,
  };
}

export function resolveMoveStartBlocks(
  page: MangaPage,
  selectedBlockIds: readonly string[],
  activeBlock: TranslationBlock,
  mode: DragMode,
): readonly TranslationBlock[] {
  if (
    mode !== "move" ||
    selectedBlockIds.length < 2 ||
    !selectedBlockIds.includes(activeBlock.id)
  ) {
    return [activeBlock];
  }
  const selectedIds = new Set(selectedBlockIds);
  const blocks = page.blocks.filter((block) => selectedIds.has(block.id));
  return blocks.length > 1 ? blocks : [activeBlock];
}

export function resolveBlockDragPreviews(
  active: ActiveBlockDrag,
  resolution: BlockDragResolution,
): ReadonlyMap<string, TranslationBlock> {
  const moveDelta = resolution.moveDelta;
  if (resolution.mode === "move" && moveDelta) {
    return new Map(
      active.moveStartBlocks.map((block) => [
        block.id,
        applyBlockMoveDelta(block, active.page, moveDelta),
      ]),
    );
  }
  return new Map([
    [
      active.drag.blockId,
      applyBlockDragResolution(active.drag.startBlock, active.page, resolution),
    ],
  ]);
}

export function resolveInitialDragHud(
  drag: DragState,
  page: MangaPage,
): DragHud {
  return {
    mode: drag.mode,
    label:
      drag.mode === "rotate"
        ? `${drag.startBlock.rotationDeg ?? 0}°`
        : describeDragBbox(drag.mode, drag.startBbox, page),
  };
}

export function hasPointerChanged(
  drag: DragState,
  event: Pick<PointerEvent, "clientX" | "clientY">,
): boolean {
  return event.clientX !== drag.startX || event.clientY !== drag.startY;
}

export function resolveBlockDragHud(
  resolution: BlockDragResolution,
  mode: DragMode,
  labels: {
    invalidCurve: string;
    invalidPerspective: string;
    invalidWarp: string;
    outsidePage: string;
    snapped: string;
  },
): DragHud {
  if (resolution.invalid) {
    return {
      mode,
      label:
        resolution.invalidKind === "curve"
          ? labels.invalidCurve
          : resolution.invalidKind === "warp"
            ? labels.invalidWarp
            : resolution.invalidKind === "outside"
              ? labels.outsidePage
              : labels.invalidPerspective,
      invalid: true,
    };
  }
  return {
    mode,
    label: resolution.snapped
      ? `${resolution.label} · ${labels.snapped}`
      : resolution.label,
  };
}
