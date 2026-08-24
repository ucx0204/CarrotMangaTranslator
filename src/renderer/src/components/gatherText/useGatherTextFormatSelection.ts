import React from "react";
import type { ChapterSnapshot } from "../../../../shared/libraryTypes";
import type { BlockStylePreset } from "../../../../shared/blockStylePresets";
import {
  deriveGatherTextDirectFormatModel,
  isGatherTextDirectFormatPatchEmpty,
  type GatherTextDirectFormatModel,
} from "../../lib/gatherTextDirectFormatModel";
import type { GatheredPage } from "../../lib/gatherText";
import {
  blockRefKey,
  findBlockByRef,
  sameBlockRef,
  type BlockRef,
  type GatherDirectFormatPatch,
  type GatherDirectFormatRequest,
} from "../../lib/gatherTextFormat";

type SelectionState = { selected: BlockRef[] };

export type GatherTextFormatSelection = {
  apply: (patch: GatherDirectFormatPatch) => void;
  clear: () => void;
  closeFormatModal: () => void;
  disabled: boolean;
  enterSelectionMode: () => void;
  exitSelectionMode: () => void;
  formatModel: GatherTextDirectFormatModel;
  isFormatModalOpen: boolean;
  isSelectionMode: boolean;
  isSelected: (ref: BlockRef) => boolean;
  openFormatModal: () => void;
  selectAllVisible: () => void;
  selectedCount: number;
  stylePresets?: readonly BlockStylePreset[];
  toggle: (ref: BlockRef) => void;
};

export function useGatherTextFormatSelection({
  blockStylePresets = [],
  chapter,
  disabled,
  onApply,
  pages,
}: {
  blockStylePresets?: readonly BlockStylePreset[];
  chapter: ChapterSnapshot | null;
  disabled: boolean;
  onApply?: (request: GatherDirectFormatRequest) => void;
  pages: GatheredPage[];
}): GatherTextFormatSelection | null {
  const visibleRefs = useVisibleBlockRefs(pages);
  const [selection, setSelection] = React.useState<SelectionState>({
    selected: [],
  });
  const [isSelectionMode, setSelectionMode] = React.useState(false);
  const [isFormatModalOpen, setFormatModalOpen] = React.useState(false);

  React.useEffect(() => {
    setSelection((current) => reconcileSelection(current, visibleRefs));
  }, [visibleRefs]);

  const selectedKeys = React.useMemo(
    () => new Set(selection.selected.map(blockRefKey)),
    [selection.selected],
  );
  const formatModel = useSelectedFormatModel(chapter, selection.selected);
  const clear = React.useCallback(() => {
    setSelection({ selected: [] });
    setFormatModalOpen(false);
  }, []);
  const exitSelectionMode = React.useCallback(() => {
    setSelectionMode(false);
    setSelection({ selected: [] });
    setFormatModalOpen(false);
  }, []);
  const apply = React.useCallback(
    (patch: GatherDirectFormatPatch) => {
      if (
        disabled ||
        !onApply ||
        selection.selected.length === 0 ||
        isGatherTextDirectFormatPatchEmpty(patch)
      ) {
        return;
      }
      onApply({ targets: selection.selected, patch });
      setFormatModalOpen(false);
    },
    [disabled, onApply, selection.selected],
  );

  if (!onApply) return null;
  return {
    apply,
    clear,
    closeFormatModal: () => setFormatModalOpen(false),
    disabled,
    enterSelectionMode: () => setSelectionMode(true),
    exitSelectionMode,
    formatModel,
    isFormatModalOpen,
    isSelectionMode,
    isSelected: (ref) => selectedKeys.has(blockRefKey(ref)),
    openFormatModal: () => {
      if (!disabled && selection.selected.length > 0) setFormatModalOpen(true);
    },
    selectAllVisible: () => setSelection({ selected: visibleRefs }),
    selectedCount: selection.selected.length,
    stylePresets: blockStylePresets,
    toggle: (ref) => setSelection((current) => toggleSelection(current, ref)),
  };
}

function useVisibleBlockRefs(pages: GatheredPage[]): BlockRef[] {
  return React.useMemo(
    () =>
      pages.flatMap((page) =>
        page.blocks.map((block) => ({
          pageId: page.pageId,
          blockId: block.id,
        })),
      ),
    [pages],
  );
}

function useSelectedFormatModel(
  chapter: ChapterSnapshot | null,
  selected: BlockRef[],
): GatherTextDirectFormatModel {
  return React.useMemo(
    () =>
      deriveGatherTextDirectFormatModel(
        selected.flatMap((ref) => {
          const block = findBlockByRef(chapter, ref);
          return block ? [block] : [];
        }),
      ),
    [chapter, selected],
  );
}

function reconcileSelection(
  current: SelectionState,
  visibleRefs: BlockRef[],
): SelectionState {
  const visibleKeys = new Set(visibleRefs.map(blockRefKey));
  const selected = current.selected.filter((ref) =>
    visibleKeys.has(blockRefKey(ref)),
  );
  return selected.length === current.selected.length &&
    selected.every((ref, index) => sameBlockRef(ref, current.selected[index]))
    ? current
    : { selected };
}

function toggleSelection(
  current: SelectionState,
  ref: BlockRef,
): SelectionState {
  const exists = current.selected.some((selected) =>
    sameBlockRef(selected, ref),
  );
  return {
    selected: exists
      ? current.selected.filter((selected) => !sameBlockRef(selected, ref))
      : [...current.selected, ref],
  };
}
