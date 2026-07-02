import {
  useCallback,
  useState,
  type Dispatch,
  type PointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  applyFormatDefaultsToBlock,
  type BlockFormatDefaults,
} from "../../../shared/blockFormat";
import { resolveBlockVisualStyle } from "../../../shared/blockVisuals";
import { estimateFontSizePx } from "../../../shared/geometry";
import { isUsableRegionBbox } from "../../../shared/region";
import type { BBox, TranslationBlock } from "../../../shared/textTypes";
import { regionSelectionToBbox } from "../lib/appHelpers";
import type { ChapterSnapshot, MangaPage } from "./hookLibraryTypes";
import {
  capturePointerSafely,
  releasePointerCaptureSafely,
} from "./workspacePointerCapture";

type UseWorkspaceBlockCreateHandlersOptions = {
  active: boolean;
  blockFormatDefaults?: BlockFormatDefaults;
  getNormalizedImagePoint: (
    event: PointerEvent,
  ) => { x: number; y: number } | null;
  pushStatus: (line: string) => void;
  selectedPage: MangaPage | null;
  selectedPageEditLocked: boolean;
  setSelectedBlockId: (blockId: string | null) => void;
  setSelectedBlockIds: Dispatch<SetStateAction<string[]>>;
  stageRef: RefObject<HTMLDivElement | null>;
  updateCurrentChapter: (
    pageId: string,
    updater: (chapter: ChapterSnapshot) => ChapterSnapshot,
    options?: { mergeKey?: string; skipHistory?: boolean },
  ) => void;
};

type BlockCreateDraft = {
  start: { x: number; y: number };
  current: { x: number; y: number };
};

/**
 * Block tool: dragging on the stage sketches a marquee and, on release,
 * appends a new empty text block covering the dragged area.
 */
export function useWorkspaceBlockCreateHandlers(
  options: UseWorkspaceBlockCreateHandlersOptions,
): {
  blockCreateRect: BBox | null;
  cancelBlockCreate: () => boolean;
  onBlockCreatePointerDown: (event: PointerEvent) => boolean;
  onBlockCreatePointerMove: (event: PointerEvent) => boolean;
  onBlockCreatePointerUp: (event: PointerEvent) => boolean;
} {
  const [draft, setDraft] = useState<BlockCreateDraft | null>(null);
  const createBlockFromBbox = useCreateBlockFromBbox(options);

  const onBlockCreatePointerDown = useCallback(
    (event: PointerEvent) => {
      if (!options.active) {
        return false;
      }
      if (!options.selectedPage || options.selectedPageEditLocked) {
        return true;
      }
      const point = options.getNormalizedImagePoint(event);
      if (!point || !options.stageRef.current || event.button !== 0) {
        return true;
      }
      event.preventDefault();
      setDraft({ start: point, current: point });
      capturePointerSafely(options.stageRef.current, event.pointerId);
      return true;
    },
    [options],
  );

  const onBlockCreatePointerMove = useCallback(
    (event: PointerEvent) => {
      if (!draft) {
        return false;
      }
      const point = options.getNormalizedImagePoint(event);
      if (point) {
        setDraft((current) =>
          current ? { ...current, current: point } : current,
        );
      }
      return true;
    },
    [draft, options],
  );

  const onBlockCreatePointerUp = useCallback(
    (event: PointerEvent) => {
      if (!draft) {
        return false;
      }
      releasePointerCaptureSafely(options.stageRef.current, event.pointerId);
      const finalPoint = options.getNormalizedImagePoint(event);
      const bbox = draftToBbox(
        finalPoint ? { ...draft, current: finalPoint } : draft,
      );
      setDraft(null);
      if (!isUsableRegionBbox(bbox, 10)) {
        options.pushStatus("블록 영역이 너무 작습니다.");
        return true;
      }
      createBlockFromBbox(bbox);
      return true;
    },
    [createBlockFromBbox, draft, options],
  );

  const cancelBlockCreate = useCallback(() => {
    if (!draft) {
      return false;
    }
    setDraft(null);
    return true;
  }, [draft]);

  return {
    blockCreateRect: draft ? draftToBbox(draft) : null,
    cancelBlockCreate,
    onBlockCreatePointerDown,
    onBlockCreatePointerMove,
    onBlockCreatePointerUp,
  };
}

function draftToBbox(draft: BlockCreateDraft): BBox {
  return regionSelectionToBbox({
    active: true,
    dragging: true,
    start: draft.start,
    current: draft.current,
  });
}

function useCreateBlockFromBbox({
  blockFormatDefaults,
  pushStatus,
  selectedPage,
  setSelectedBlockId,
  setSelectedBlockIds,
  updateCurrentChapter,
}: UseWorkspaceBlockCreateHandlersOptions): (bbox: BBox) => void {
  return useCallback(
    (bbox: BBox) => {
      if (!selectedPage) {
        return;
      }
      const block = buildManualBlock(selectedPage, bbox, blockFormatDefaults);
      updateCurrentChapter(selectedPage.id, (chapter) => ({
        ...chapter,
        pages: chapter.pages.map((page) =>
          page.id !== selectedPage.id
            ? page
            : {
                ...page,
                updatedAt: new Date().toISOString(),
                blocks: [...page.blocks, block],
              },
        ),
      }));
      setSelectedBlockId(block.id);
      setSelectedBlockIds([block.id]);
      pushStatus("새 텍스트 블록을 추가했습니다.");
    },
    [
      blockFormatDefaults,
      pushStatus,
      selectedPage,
      setSelectedBlockId,
      setSelectedBlockIds,
      updateCurrentChapter,
    ],
  );
}

function buildManualBlock(
  page: MangaPage,
  bbox: BBox,
  formatDefaults: BlockFormatDefaults | undefined,
): TranslationBlock {
  const visualStyle = resolveBlockVisualStyle("nonsolid");
  return applyFormatDefaultsToBlock(
    {
      id: `${page.id}-manual-${Date.now()}`,
      type: "nonsolid",
      bbox,
      bboxSpace: "normalized_1000",
      sourceText: "",
      translatedText: "",
      confidence: 1,
      sourceDirection: "horizontal",
      renderDirection: "horizontal",
      rotationDeg: 0,
      fontSizePx: estimateFontSizePx("...", bbox, {
        width: page.width,
        height: page.height,
      }),
      lineHeight: 1.18,
      textAlign: "center",
      textColor: "#111111",
      outlineColor: "#ffffff",
      backgroundColor: visualStyle.backgroundColor,
      opacity: visualStyle.defaultOpacity,
      autoFitText: true,
    },
    formatDefaults,
  );
}
